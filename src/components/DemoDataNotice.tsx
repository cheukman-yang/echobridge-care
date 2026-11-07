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
  return (
    <Notice
      tone="caution"
      testId="demo-data-notice"
      title={side === 'user' ? '実在の個人情報は入力しないでください' : '実在の個人情報は話さないでください'}
      className={className}
    >
      {side === 'user' ? (
        <p>
          これはデモ版です。氏名・病名・保険証の番号などは使わず、架空の内容でお試しください。入力した文と相手の声は、文字起こしと返答の作成のためにGoogle
          Cloud（Speech-to-Text、Gemini）で処理されます。
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
