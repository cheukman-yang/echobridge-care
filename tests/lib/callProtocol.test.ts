import { describe, expect, it } from 'vitest';
import { buildGreeting } from '@/lib/callProtocol';

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
