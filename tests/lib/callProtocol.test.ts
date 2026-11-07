import { describe, expect, it } from 'vitest';
import {
  buildGreeting,
  buildInviteUrl,
  formatInviteCode,
  normalizeInviteCode,
  parseInviteFromHash,
} from '@/lib/callProtocol';
import { MAX_PARTNER_NAME_LENGTH, normalizePartnerName } from '@/lib/callPurpose';

describe('招待コード', () => {
  it.each([
    ['小文字', 'abcde12345', 'ABCDE12345'],
    ['区切り', 'ABCDE-12345', 'ABCDE12345'],
    ['前後の空白', '  ABCDE12345\n', 'ABCDE12345'],
    ['全角', 'ＡＢＣＤＥ－１２３４５', 'ABCDE12345'],
    ['長音記号の区切り', 'ABCDEー12345', 'ABCDE12345'],
    ['読み間違えやすい文字', 'OoIiLl', '001111'],
  ])('%sを同じコードとして読む', (_, input, expected) => {
    expect(normalizeInviteCode(input)).toBe(expected);
  });

  it('表示用に中央で区切る', () => {
    expect(formatInviteCode('ABCDE12345')).toBe('ABCDE-12345');
  });

  it('リンクのコードをフラグメントに入れ、取り出せる', () => {
    const url = new URL(buildInviteUrl('https://echo.example', 'ABCDE12345'));

    expect(url.pathname).toBe('/join');
    expect(url.search).toBe('');
    expect(parseInviteFromHash(url.hash)).toBe('ABCDE12345');
  });

  it('招待のないフラグメントでは何も返さない', () => {
    expect(parseInviteFromHash('')).toBeNull();
    expect(parseInviteFromHash('#other=1')).toBeNull();
    expect(parseInviteFromHash('#invite=')).toBeNull();
  });
});

describe('buildGreeting', () => {
  it('本人の文を活用させず、そのまま1文として続ける', () => {
    const greeting = buildGreeting('内科の初診予約をしたいです');

    expect(greeting).toContain('内科の初診予約をしたいです。');
    expect(greeting).not.toContain('をお願いしたいのですが');
  });

  it('文末に記号があれば句点を足さない', () => {
    expect(buildGreeting('予約はできますか？')).toMatch(/予約はできますか？$/);
    expect(buildGreeting('予約をお願いします。')).toMatch(/予約をお願いします。$/);
  });

  it('前後の空白だけを取り除く', () => {
    expect(buildGreeting('  再診の予約です \n')).toMatch(/再診の予約です。$/);
  });

  it('目的ごとに前置きを変え、本人の文はどちらも変えない', () => {
    const medical = buildGreeting('土曜に会えますか', 'medical');
    const general = buildGreeting('土曜に会えますか', 'general');

    expect(medical).toMatch(/^お忙しいところ恐れ入ります。/);
    expect(general).not.toContain('お電話しております');
    expect(general).toContain('AI音声アシスタント');
    expect(medical).toMatch(/土曜に会えますか。$/);
    expect(general).toMatch(/土曜に会えますか。$/);
  });
});

describe('normalizePartnerName', () => {
  it('改行や制御文字を空白にして1行にする', () => {
    expect(normalizePartnerName('  ひまわり\n医院\t受付 ')).toBe('ひまわり 医院 受付');
  });

  it('上限より長い名前を切り詰める', () => {
    expect(normalizePartnerName('あ'.repeat(MAX_PARTNER_NAME_LENGTH + 5))).toHaveLength(
      MAX_PARTNER_NAME_LENGTH,
    );
  });
});
