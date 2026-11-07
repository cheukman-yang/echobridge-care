import { describe, expect, it } from 'vitest';
import {
  INITIAL_COMPOSER,
  composerReducer,
  findNumberChanges,
  resolveConfirmedSpeech,
} from '@/lib/composer';
import type { ComposerState } from '@/lib/composer';

const GEMINI = { source: 'gemini', model: 'test-model' } as const;
const FALLBACK = { source: 'fallback', reason: 'timeout' } as const;

const polishing = composerReducer(INITIAL_COMPOSER, {
  type: 'request',
  requestId: 'r1',
  original: 'あした行けます',
});

const reviewing = composerReducer(polishing, {
  type: 'result',
  requestId: 'r1',
  polished: '明日伺うことができます。',
  ai: GEMINI,
});

describe('composerReducer', () => {
  it('AIの結果が届くと確認待ちになる', () => {
    expect(reviewing).toMatchObject({
      phase: 'reviewing',
      original: 'あした行けます',
      draft: '明日伺うことができます。',
    });
  });

  it('AIが失敗すると、案を持たない失敗状態になる', () => {
    const failed = composerReducer(polishing, {
      type: 'result',
      requestId: 'r1',
      polished: null,
      ai: FALLBACK,
    });

    expect(failed).toEqual({ phase: 'failed', original: 'あした行けます', reason: 'timeout' });
  });

  it('依頼と違う結果や、閉じた後の結果を無視する', () => {
    const stale = composerReducer(polishing, {
      type: 'result',
      requestId: 'old',
      polished: '別の文',
      ai: GEMINI,
    });
    expect(stale).toBe(polishing);

    const closed = composerReducer(polishing, { type: 'close' });
    const late = composerReducer(closed, {
      type: 'result',
      requestId: 'r1',
      polished: '別の文',
      ai: GEMINI,
    });
    expect(late).toEqual(INITIAL_COMPOSER);
  });

  it('待っている間に接続が切れたら失敗として本人に見せる', () => {
    expect(composerReducer(polishing, { type: 'connection_lost' })).toEqual({
      phase: 'failed',
      original: 'あした行けます',
      reason: 'unavailable',
    });
  });

  it('確認中に接続が切れても案は消さない', () => {
    expect(composerReducer(reviewing, { type: 'connection_lost' })).toBe(reviewing);
  });
});

describe('resolveConfirmedSpeech', () => {
  it('AIの結果を受け取っただけでは何も送れない状態を保つ', () => {
    expect(resolveConfirmedSpeech(INITIAL_COMPOSER, 'draft')).toBeNull();
    expect(resolveConfirmedSpeech(polishing, 'draft')).toBeNull();
    expect(resolveConfirmedSpeech(polishing, 'original')).toBeNull();
  });

  it('確認した案をそのまま返す', () => {
    expect(resolveConfirmedSpeech(reviewing, 'draft')).toEqual({
      text: '明日伺うことができます。',
      origin: 'ai_reviewed',
    });
  });

  it('本人が直した文は編集済みとして、直したとおりに返す', () => {
    const edited = composerReducer(reviewing, { type: 'edit_draft', draft: '明後日伺います。' });

    expect(resolveConfirmedSpeech(edited, 'draft')).toEqual({
      text: '明後日伺います。',
      origin: 'ai_edited',
    });
  });

  it('原文を選ぶと入力どおりの文を返す', () => {
    expect(resolveConfirmedSpeech(reviewing, 'original')).toEqual({
      text: 'あした行けます',
      origin: 'typed',
    });
  });

  it('失敗時は原文だけを送れる', () => {
    const failed: ComposerState = { phase: 'failed', original: 'いいえ', reason: 'timeout' };

    expect(resolveConfirmedSpeech(failed, 'draft')).toBeNull();
    expect(resolveConfirmedSpeech(failed, 'original')).toEqual({ text: 'いいえ', origin: 'typed' });
  });

  it('案を空にしたら送れない', () => {
    const emptied = composerReducer(reviewing, { type: 'edit_draft', draft: '   ' });

    expect(resolveConfirmedSpeech(emptied, 'draft')).toBeNull();
  });
});

describe('findNumberChanges', () => {
  it('同じ数字なら何も知らせない', () => {
    expect(findNumberChanges('午後3時に伺います', '午後3時に伺います。')).toEqual({
      removed: [],
      added: [],
    });
  });

  it('全角と半角は同じ数字として扱う', () => {
    expect(findNumberChanges('３時', '3時')).toEqual({ removed: [], added: [] });
  });

  it('数字が変わると増減を返す', () => {
    expect(findNumberChanges('3時に行きます', '13時に伺います')).toEqual({
      removed: ['3'],
      added: ['13'],
    });
  });

  it('消えた数字を見逃さない', () => {
    expect(findNumberChanges('10日の9時', '10日に')).toEqual({ removed: ['9'], added: [] });
  });
});
