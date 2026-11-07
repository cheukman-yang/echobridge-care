import { describe, expect, it } from 'vitest';
import {
  buildGreeting,
  buildInviteUrl,
  formatInviteCode,
  normalizeInviteCode,
  parseInviteFromHash,
} from '@/lib/callProtocol';

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

    expect(url.pathname).toBe('/hospital');
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
});
