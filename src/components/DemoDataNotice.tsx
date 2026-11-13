"use client";

import { useUserLanguage } from '@/contexts/UserLanguageContext';
import { Notice } from './ui';

interface DemoDataNoticeProps {
  /** 本人は入力と発話、相手は発話だけをする。送り先の説明をそれぞれに合わせる。 */
  side: 'user' | 'partner';
  className?: string;
}

/**
 * 公開URLで誰でも試せるため、実在の個人情報を使わないよう、通話を始める前に伝える。
 * 音声と文字がGoogle Cloudで処理されることも、ここで隠さずに示す。
 */
export function DemoDataNotice({ side, className }: DemoDataNoticeProps) {
  const { userLanguage } = useUserLanguage();
  const isEn = side === 'user' && userLanguage === 'en';

  return (
    <Notice
      tone="caution"
      testId="demo-data-notice"
      title={
        isEn
          ? 'Do not enter real personal information'
          : side === 'user'
          ? '実在の個人情報は入力しないでください'
          : '実在の個人情報は話さないでください'
      }
      className={className}
    >
      {isEn ? (
        <p>
          This is a demo environment. Please use fictional names, symptoms, and insurance details. Your text and speech
          are processed via Google Cloud (Speech-to-Text, Gemini, Text-to-Speech) for transcription, translation, and
          voice synthesis.
        </p>
      ) : side === 'user' ? (
        <p>
          これはデモ版です。氏名・病名・保険証の番号などは使わず、架空の内容でお試しください。入力した文と相手の声は、文字起こし・返答の作成・読み上げのためにGoogle
          Cloud（Speech-to-Text、Gemini、Text-to-Speech）で処理されます。
        </p>
      ) : (
        <p>
          これはデモ版です。氏名・病名などは使わず、架空の内容でお話しください。あなたの声は、文字起こしと返答の作成のためにGoogle
          Cloud（Speech-to-Text、Gemini）で処理されます。
        </p>
      )}
    </Notice>
  );
}
