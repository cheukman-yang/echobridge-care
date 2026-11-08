// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PATIENT_TEXT_LENGTH } from '@/lib/callProtocol';
import {
  CUSTOM_PHRASES_KEY,
  MAX_CUSTOM_PHRASES,
  clearCustomPhrases,
  createPhraseId,
  getCustomPhrasesSnapshot,
  normalizePhraseText,
  parseCustomPhrases,
  saveCustomPhrases,
  validatePhrase,
} from '@/lib/customPhrases';
import type { CustomPhrase } from '@/lib/customPhrases';

const phrase = (id: string, text: string): CustomPhrase => ({ id, text });

beforeEach(() => {
  clearCustomPhrases();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('登録する文の検査', () => {
  it('改行を空白にし、前後の空白を除く', () => {
    expect(normalizePhraseText('  はじめまして。\n よろしくお願いします。 ')).toBe('はじめまして。 よろしくお願いします。');
  });

  it('空・長すぎ・重複・上限超えは理由を返す', () => {
    const list = [phrase('a', '自己紹介の文')];
    expect(validatePhrase('   ', list)).toBe('empty');
    expect(validatePhrase('あ'.repeat(MAX_PATIENT_TEXT_LENGTH + 1), list)).toBe('too_long');
    expect(validatePhrase(' 自己紹介の文 ', list)).toBe('duplicate');
    const full = Array.from({ length: MAX_CUSTOM_PHRASES }, (_, index) => phrase(String(index), `文${index}`));
    expect(validatePhrase('新しい文', full)).toBe('full');
    expect(validatePhrase('新しい文', list)).toBeNull();
  });

  it('直している文そのものは重複にせず、上限でも直せる', () => {
    const full = Array.from({ length: MAX_CUSTOM_PHRASES }, (_, index) => phrase(String(index), `文${index}`));
    expect(validatePhrase('文0', full, '0')).toBeNull();
    expect(validatePhrase('直した文', full, '0')).toBeNull();
  });
});

describe('保存した文の読み込み', () => {
  it('壊れた値や形の違う値は捨てる', () => {
    expect(parseCustomPhrases('{not json')).toEqual([]);
    expect(parseCustomPhrases('{"id":"a"}')).toEqual([]);
    expect(
      parseCustomPhrases(JSON.stringify([phrase('a', '残る文'), { id: 1, text: '番号が数値' }, phrase('b', '  '), null])),
    ).toEqual([phrase('a', '残る文')]);
  });

  it('上限より多く保存されていても、上限までしか出さない', () => {
    const many = Array.from({ length: MAX_CUSTOM_PHRASES + 5 }, (_, index) => phrase(String(index), `文${index}`));
    expect(parseCustomPhrases(JSON.stringify(many))).toHaveLength(MAX_CUSTOM_PHRASES);
  });

  it('保存すると同じ値を返し、変わらなければ同じ配列を返す', () => {
    expect(saveCustomPhrases([phrase('a', '文')])).toBe(true);
    const first = getCustomPhrasesSnapshot();
    expect(first).toEqual([phrase('a', '文')]);
    expect(getCustomPhrasesSnapshot()).toBe(first);
    expect(JSON.parse(window.localStorage.getItem(CUSTOM_PHRASES_KEY) ?? '[]')).toEqual([phrase('a', '文')]);
  });

  it('端末に保存できないときは false を返し、この画面の中だけで保つ', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(saveCustomPhrases([phrase('a', '画面の中だけの文')])).toBe(false);
    expect(getCustomPhrasesSnapshot()).toEqual([phrase('a', '画面の中だけの文')]);
  });

  it('すべて削除すると、端末からも画面の中からも消える', () => {
    saveCustomPhrases([phrase('a', '消す文')]);

    clearCustomPhrases();

    expect(window.localStorage.getItem(CUSTOM_PHRASES_KEY)).toBeNull();
    expect(getCustomPhrasesSnapshot()).toEqual([]);
  });
});

describe('登録した文の番号', () => {
  it('crypto.randomUUID が使えない画面（LANのhttp）でも、重ならない番号を作る', () => {
    // 安全でない画面では randomUUID がない。インスタンスに undefined を置いて同じ状態にする。
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => createPhraseId()));
      expect(ids.size).toBe(50);
    } finally {
      Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    }
    expect(typeof globalThis.crypto.randomUUID).toBe('function');
  });
});
