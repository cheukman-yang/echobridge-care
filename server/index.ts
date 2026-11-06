import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import speech from '@google-cloud/speech';
import { generateSuggestionsWithGemini } from './geminiService';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/call' });

const speechClient = new speech.SpeechClient();
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

let currentHospitalTranscript = '';
let currentPatientIntent = '';
let callHistory: { sender: string; text: string }[] = [];
let isHospitalRecording = false;

const broadcast = (data: any) => {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
};

const brushUpText = async (rawText: string): Promise<string> => {
  const cleaned = rawText.trim().replace(/[。、！？.!?]+$/, '');
  const lower = cleaned.toLowerCase();

  const dict: { [key: string]: string } = {
    'はい': 'はい、よろしくお願いいたします。',
    'わかった': '承知いたしました。',
    'わかりました': '承知いたしました。',
    '了解': '承知いたしました。',
    '了解です': '承知いたしました。',
    'ok': 'かしこまりました。そちらでお願いいたします。',
    'okです': 'かしこまりました。そちらでお願いいたします。',
    'okay': 'かしこまりました。そちらでお願いいたします。',
    'okayです': 'かしこまりました。そちらでお願いいたします。',
    'おけ': 'かしこまりました。そちらでお願いいたします。',
    'yes': 'はい、そちらでお願いいたします。',
    'yesです': 'はい、そちらでお願いいたします。',
    'yep': 'はい、そちらでお願いいたします。',
    'いいえ': 'いいえ、そちらは都合が合いません。',
    'no': 'いいえ、そちらは都合が合いません。',
    'noです': 'いいえ、そちらは都合が合いません。',
    'nope': 'いいえ、そちらは都合が合いません。',
    'ない': '特にございません。',
    'ないです': '特にございません。',
    'ありがとう': 'ありがとうございます。',
    'ありがとうございます': 'ありがとうございます。',
    'ありがとうございました': 'ありがとうございました。失礼いたします。',
    'thanks': 'ありがとうございます。よろしくお願いいたします。',
    'thank you': 'ありがとうございます。よろしくお願いいたします。',
    '大丈夫': '問題ございません。大丈夫です。',
    '大丈夫です': '問題ございません。大丈夫です。'
  };

  if (dict[lower] || dict[cleaned]) {
    return dict[lower] || dict[cleaned];
  }

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const prompt = `あなたは聴覚・発話困難者のための電話代行アシスタントです。
患者が手入力したメッセージを、病院の受付に伝えるための「最も自然で丁寧な電話口の敬語1文」に変換してください。
決して文末に「〜です。」を機械的に付けず、前後の文脈に即した美しい敬語1文にしてください。
前置きや解説は一切出力せず、変換後の文のみを出力してください。

患者の入力: "${cleaned}"`;

      const res = await model.generateContent(prompt);
      const text = res.response.text().trim();
      if (text) return text;
    } catch (err) {
      console.error('[Gemini BrushUp Error]', err);
    }
  }

  if (
    cleaned.endsWith('か') || 
    cleaned.endsWith('ます') || 
    cleaned.endsWith('でした') || 
    cleaned.endsWith('ございます') || 
    cleaned.endsWith('です')
  ) {
    return `${cleaned}。`;
  }

  return `${cleaned}です。`;
};

const extractAppointmentFromHistory = async (history: { sender: string; text: string }[]) => {
  const conversation = history.map((h) => `${h.sender}: ${h.text}`).join('\n');
  console.log('[Extract] 会話ログ解析:\n', conversation);

  const now = new Date();
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

  const isTomorrow = conversation.includes('明日') || conversation.includes('あした');
  
  const targetDate = new Date(now);
  if (isTomorrow) {
    targetDate.setDate(targetDate.getDate() + 1);
  }

  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const day = targetDate.getDate();
  const dayOfWeek = dayNames[targetDate.getDay()];

  const prefix = isTomorrow ? '明日' : '本日';
  const dateLabel = `${prefix} ${month}月${day}日(${dayOfWeek})`;
  
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateYmd = `${year}${pad(month)}${pad(day)}`;

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

  const hourStr = pad(detectedHour);
  const nextHourStr = pad((detectedHour + 1) % 24);

  let cleanTitle = currentPatientIntent ? currentPatientIntent.trim() : '内科 初診予約';
  if (!cleanTitle.includes('予約')) {
    cleanTitle += ' 予約';
  }

  const requiredItems: string[] = [];

  const hasMyna = conversation.includes('マイナンバー') || conversation.includes('マイナ');
  const hasShikaku = conversation.includes('資格確認書') || conversation.includes('確認書');
  const hasHokensho = conversation.includes('保険証') && !hasShikaku;
  const hasOkusuri = conversation.includes('お薬手帳') || conversation.includes('おくすり手帳');

  if (hasMyna && (hasShikaku || hasHokensho)) {
    const secondItem = hasShikaku ? '健康保険資格確認書' : '健康保険証';
    requiredItems.push(`マイナンバーカード または ${secondItem}`);
  } else {
    if (hasMyna) requiredItems.push('マイナンバーカード');
    if (hasShikaku) requiredItems.push('健康保険資格確認書');
    if (hasHokensho) requiredItems.push('健康保険証');
  }

  if (hasOkusuri) {
    requiredItems.push('お薬手帳');
  }

  const notes: string[] = [];
  if (requiredItems.length > 0) {
    notes.push(`持ち物: ${requiredItems.join('、')}`);
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
    const currentTodayLabel = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日(${dayNames[now.getDay()]})`;
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `通話履歴から予約情報を抽出してください。
現在の日時は【${currentTodayLabel}】です。
会話の中で「本日」「明日」や具体的な日付、時間が決定されている場合は正確に反映してください。
detailsには、会話で言及された持ち物（「マイナンバーカード」「健康保険資格確認書」「健康保険証」「お薬手帳」など）や注意事項を漏れなく正確に記載してください。「マイナンバーカードまたは健康保険資格確認書」のように選択肢として言及されている場合は、その通りに記載してください。

通話履歴:
${conversation}

出力スキーマ:
{
  "title": "${cleanTitle}",
  "dateDisplay": "${dateLabel} ${hourStr}:00 〜 ${nextHourStr}:00",
  "startTimeIso": "${dateYmd}T${hourStr}0000",
  "endTimeIso": "${dateYmd}T${nextHourStr}0000",
  "location": "ひまわり医院 (受付)",
  "details": "持ち物や決定事項のメモ (例: 持ち物: マイナンバーカード または 健康保険資格確認書)"
}`;

    const res = await model.generateContent(prompt);
    return JSON.parse(res.response.text().trim());
  } catch (e) {
    return fallback;
  }
};

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] クライアント接続 (接続数:', wss.clients.size, ')');
  let recognizeStream: any = null;

  const stopRecognitionStream = () => {
    if (recognizeStream) {
      recognizeStream.removeAllListeners('data');
      recognizeStream.removeAllListeners('error');
      recognizeStream.end();
      recognizeStream = null;
    }
  };

  const startRecognitionStream = () => {
    stopRecognitionStream();

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
            if (isHospitalRecording) startRecognitionStream();
          }
        })
        .on('data', onSpeechData);
    } catch (e) {
      console.error('[Speech Setup Error]', e);
    }
  };

  const onSpeechData = (data: any) => {
    if (!isHospitalRecording) return;
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
          currentPatientIntent = data.intent || '';
          callHistory = [];
          isHospitalRecording = false;
          stopRecognitionStream();
          broadcast({ type: 'start_call', intent: data.intent });
          return;
        } else if (data.type === 'answer_call') {
          const greeting = `お忙しいところ恐れ入ります。AI音声アシスタントを介してお電話しております。${currentPatientIntent}をお願いしたいのですが、よろしいでしょうか？`;
          callHistory.push({ sender: '患者', text: greeting });
          broadcast({ type: 'answer_call', text: greeting });
          return;
        } else if (data.type === 'hospital_speaking_start') {
          isHospitalRecording = true;
          currentHospitalTranscript = '';
          startRecognitionStream();
          broadcast({ type: 'hospital_speaking_start' });
          return;
        } else if (data.type === 'hospital_speaking_stop') {
          isHospitalRecording = false;
          stopRecognitionStream();
          broadcast({ type: 'hospital_speaking_stop' });
          return;
        } else if (data.type === 'hospital_speech_end' || data.type === 'force_finalize') {
          isHospitalRecording = false;
          stopRecognitionStream();

          const textToAnalyze = currentHospitalTranscript.trim();
          currentHospitalTranscript = '';

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
          return;
        } else if (data.type === 'patient_typing_notice') {
          const noticeText = '通話内容入力中のためお待ちください';
          broadcast({ type: 'patient_typing_notice', text: noticeText });
          return;
        } else if (data.type === 'patient_send') {
          const brushedUp = await brushUpText(data.text);
          callHistory.push({ sender: '患者', text: brushedUp });
          broadcast({ type: 'patient_speech', text: brushedUp });
          return;
        } else if (data.type === 'patient_speech_direct') {
          callHistory.push({ sender: '患者', text: data.text });
          broadcast({ type: 'patient_speech', text: data.text });
          return;
        } else if (data.type === 'patient_speaking_status') {
          broadcast({ type: 'patient_speaking_status', isSpeaking: data.isSpeaking });
          return;
        } else if (data.type === 'end_call') {
          isHospitalRecording = false;
          stopRecognitionStream();
          broadcast({ type: 'call_ending' });
          const appointment = await extractAppointmentFromHistory(callHistory);
          broadcast({ type: 'end_call', appointment });

          currentHospitalTranscript = '';
          currentPatientIntent = '';
          return;
        } else if (data.type === 'reset_call') {
          isHospitalRecording = false;
          stopRecognitionStream();
          currentHospitalTranscript = '';
          currentPatientIntent = '';
          callHistory = [];
          broadcast({ type: 'reset_call' });
          return;
        }
      } catch {}
    }

    if (isBinary && isHospitalRecording && recognizeStream && recognizeStream.writable) {
      recognizeStream.write(message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] クライアント切断 (現在の接続数:', wss.clients.size, ')');
    if (wss.clients.size === 0) {
      stopRecognitionStream();
      currentHospitalTranscript = '';
      isHospitalRecording = false;
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`> EchoBridge WS Server running on ws://localhost:${PORT}/ws/call`);
});