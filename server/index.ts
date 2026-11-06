import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import speech from '@google-cloud/speech';
import { generateSuggestionsWithGemini } from './geminiService';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/call' });

const speechClient = new speech.SpeechClient();
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

let currentHospitalTranscript = '';
let currentPatientIntent = '';
let callHistory: { sender: string; text: string }[] = [];

const broadcast = (data: any) => {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
};

const brushUpText = async (rawText: string): Promise<string> => {
  const trimmed = rawText.trim();
  const dict: { [key: string]: string } = {
    'わかった': '承知いたしました。',
    'わかりました': '承知いたしました。',
    '了解': '承知いたしました。',
    '了解です': '承知いたしました。',
    'ありがとう': 'ありがとうございます。',
    'ありがとうございます': 'ありがとうございます。',
    '大丈夫': '問題ございません。大丈夫です。',
    '大丈夫です': '問題ございません。大丈夫です。',
    'OK': 'かしこまりました。そちらでお願いいたします。',
    'OKです': 'かしこまりました。そちらでお願いいたします。',
    'おけ': 'かしこまりました。そちらでお願いいたします。',
    'はい': 'はい、よろしくお願いいたします。',
    'いいえ': 'いいえ、そちらは都合が合いません。',
    'ない': '特にございません。',
    'ないです': '特にございません。'
  };

  if (dict[trimmed]) return dict[trimmed];

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const prompt = `あなたは聴覚・発話困難者のための電話代行アシスタントです。
患者が手入力したメッセージを、病院の受付に伝えるための「最も自然で丁寧な電話口の敬語1文」に変換してください。
機械的に「〜でお願いいたします」を文末に付けず、文脈に合わせて適切な敬語表現を選んでください。
前置きや解説は一切不要です。変換後の1文のみを出力してください。

患者の入力: "${trimmed}"`;

      const res = await model.generateContent(prompt);
      const text = res.response.text().trim();
      if (text) return text;
    } catch (err) {
      console.error('[Gemini BrushUp Error]', err);
    }
  }

  if (trimmed.endsWith('か') || trimmed.endsWith('？') || trimmed.endsWith('?')) {
    return trimmed;
  }
  return `${trimmed}です。`;
};

const extractAppointmentFromHistory = async (history: { sender: string; text: string }[]) => {
  const conversation = history.map((h) => `${h.sender}: ${h.text}`).join('\n');
  console.log('[Extract] 会話ログ解析:\n', conversation);

  const isTomorrow = conversation.includes('明日') || conversation.includes('あした');
  const dateLabel = isTomorrow ? '明日 11月7日(土)' : '本日 11月6日(金)';
  const dateYmd = isTomorrow ? '20261107' : '20261106';

  let detectedHour = 18;
  const matches = [...conversation.matchAll(/(午後|午前)?\s*([0-9０-９一二三四五六七八九十]+)\s*時/g)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    const ampm = lastMatch[1] || '';
    const rawNum = lastMatch[2];
    let num = parseInt(rawNum.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)), 10);
    if (isNaN(num)) {
      const kanjiMap: { [key: string]: number } = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      num = kanjiMap[rawNum] || 18;
    }

    if (ampm === '午後' || (num <= 7 && ampm !== '午前')) {
      detectedHour = num <= 12 ? num + 12 : num;
    } else {
      detectedHour = num;
    }
  }

  const hourStr = String(detectedHour).padStart(2, '0');
  const nextHourStr = String((detectedHour + 1) % 24).padStart(2, '0');

  let cleanTitle = currentPatientIntent ? currentPatientIntent.trim() : '内科 初診予約';
  if (!cleanTitle.includes('予約')) {
    cleanTitle += ' 予約';
  }

  const notes: string[] = [];
  if (conversation.includes('マイナンバー') || conversation.includes('マイナ')) {
    notes.push('持ち物: マイナンバーカード');
  }
  if (conversation.includes('保険証')) {
    notes.push('持ち物: 健康保険証');
  }
  if (conversation.includes('初診')) {
    notes.push('初診受付');
  }
  const fallbackDetails = notes.length > 0 
    ? `${notes.join(' / ')} (EchoBridge電話予約)`
    : 'EchoBridge経由での電話予約';

  const fallback = {
    title: cleanTitle,
    dateDisplay: `${dateLabel} ${hourStr}:00 〜 ${nextHourStr}:00`,
    startTimeIso: `${dateYmd}T${hourStr}0000`,
    endTimeIso: `${dateYmd}T${nextHourStr}0000`,
    location: 'ひまわり医院 (受付)',
    details: fallbackDetails
  };

  if (!genAI) return fallback;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const prompt = `通話履歴から予約情報を抽出してください。現在日時は2026年11月6日金曜日です。
「明日」と合意されている場合は日付を2026年11月7日(土)としてください。
detailsには、会話で言及された持ち物（マイナンバーカードや保険証など）や注意事項を簡潔に要約して記載してください。

通話履歴:
${conversation}

出力スキーマ:
{
  "title": "${cleanTitle}",
  "dateDisplay": "${dateLabel} ${hourStr}:00 〜 ${nextHourStr}:00",
  "startTimeIso": "${dateYmd}T${hourStr}0000",
  "endTimeIso": "${dateYmd}T${nextHourStr}0000",
  "location": "ひまわり医院 (受付)",
  "details": "具体的な持ち物や決定事項のメモ (例: 持ち物: マイナンバーカード持参)"
}`;

    const res = await model.generateContent(prompt);
    return JSON.parse(res.response.text().trim());
  } catch (e) {
    return fallback;
  }
};

wss.on('connection', (ws) => {
  console.log('[WS] クライアント接続 (接続数:', wss.clients.size, ')');
  let recognizeStream: any = null;

  const startRecognitionStream = () => {
    if (recognizeStream) {
      recognizeStream.removeAllListeners();
      recognizeStream.end();
      recognizeStream = null;
    }

    const request = {
      config: {
        encoding: 'LINEAR16' as const,
        sampleRateHertz: 16000,
        languageCode: 'ja-JP',
      },
      interimResults: true,
    };

    try {
      recognizeStream = speechClient.streamingRecognize(request)
        .on('error', (error: any) => {
          if (error.message && error.message.includes('Long duration elapsed without audio')) {
            startRecognitionStream();
          }
        })
        .on('data', onSpeechData);
    } catch (e) {
      console.error('[Speech Setup Error]', e);
    }
  };

  // 音声認識されたら即座にテキストを患者側へブロードキャスト（リアルタイム出力）
  const onSpeechData = (data: any) => {
    const result = data.results[0];
    if (result && result.alternatives[0]) {
      const transcript = result.alternatives[0].transcript;
      currentHospitalTranscript = transcript;

      broadcast({
        type: 'transcript_interim',
        text: transcript,
      });
    }
  };

  ws.on('message', async (message: any, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'start_call') {
          console.log('[WS] 患者から発信:', data.intent);
          currentPatientIntent = data.intent || '';
          callHistory = [];
          broadcast({ type: 'start_call', intent: data.intent });
          return;
        } else if (data.type === 'answer_call') {
          console.log('[WS] 病院が応答');
          const greeting = `お忙しいところ恐れ入ります。AI音声アシスタントを介してお電話しております。${currentPatientIntent}をお願いしたいのですが、よろしいでしょうか？`;
          callHistory.push({ sender: '患者', text: greeting });
          broadcast({ type: 'answer_call', text: greeting });
          if (!recognizeStream) startRecognitionStream();
          return;
        } else if (data.type === 'hospital_speaking_start') {
          // PTT押下を即座にブロードキャスト（パルス点灯）
          broadcast({ type: 'hospital_speaking_start' });
          if (!recognizeStream) startRecognitionStream();
          return;
        } else if (data.type === 'hospital_speaking_stop') {
          broadcast({ type: 'hospital_speaking_stop' });
          return;
        } else if (data.type === 'hospital_speech_end' || data.type === 'force_finalize') {
          const textToAnalyze = currentHospitalTranscript.trim();
          console.log('[Gemini] マイク解除。確定テキスト:', textToAnalyze);

          if (recognizeStream) {
            recognizeStream.removeAllListeners('data');
            recognizeStream.end();
            recognizeStream = null;
          }

          if (textToAnalyze) {
            callHistory.push({ sender: '病院受付', text: textToAnalyze });
            broadcast({ type: 'transcript_final', text: textToAnalyze });
            broadcast({ type: 'generating_suggestions' });

            try {
              const geminiResult = await generateSuggestionsWithGemini(textToAnalyze);
              broadcast({
                type: 'suggestions',
                suggestions: geminiResult.suggestions || geminiResult || [],
              });
            } catch (err) {
              console.error('[Gemini Error]', err);
              broadcast({ type: 'suggestions', suggestions: [] });
            }
          } else {
            broadcast({ type: 'hospital_speaking_stop' });
          }
          currentHospitalTranscript = '';
          return;
        } else if (data.type === 'patient_send') {
          console.log('[WS] 患者手入力:', data.text);
          const brushedUp = await brushUpText(data.text);
          callHistory.push({ sender: '患者', text: brushedUp });
          broadcast({ type: 'patient_speech', text: brushedUp });
          return;
        } else if (data.type === 'patient_speech_direct') {
          callHistory.push({ sender: '患者', text: data.text });
          broadcast({ type: 'patient_speech', text: data.text });
          return;
        } else if (data.type === 'end_call') {
          console.log('[WS] 通話終了');
          if (recognizeStream) {
            recognizeStream.removeAllListeners();
            recognizeStream.end();
            recognizeStream = null;
          }

          broadcast({ type: 'call_ending' });
          const appointment = await extractAppointmentFromHistory(callHistory);
          console.log('[WS] 予約抽出結果:', appointment);
          broadcast({ type: 'end_call', appointment });

          currentHospitalTranscript = '';
          currentPatientIntent = '';
          return;
        } else if (data.type === 'reset_call') {
          console.log('[WS] 全クライアントをリセット');
          if (recognizeStream) {
            recognizeStream.removeAllListeners();
            recognizeStream.end();
            recognizeStream = null;
          }
          currentHospitalTranscript = '';
          currentPatientIntent = '';
          callHistory = [];
          broadcast({ type: 'reset_call' });
          return;
        }
      } catch {
        // バイナリフォールスルー
      }
    }

    if (!recognizeStream) startRecognitionStream();
    if (recognizeStream && recognizeStream.writable) {
      recognizeStream.write(message);
    }
  });

  ws.on('close', () => {
    if (wss.clients.size === 0 && recognizeStream) {
      recognizeStream.removeAllListeners();
      recognizeStream.end();
      recognizeStream = null;
      currentHospitalTranscript = '';
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`> EchoBridge WS Server running on ws://localhost:${PORT}/ws/call`);
});