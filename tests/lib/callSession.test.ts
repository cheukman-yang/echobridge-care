// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadSeatToken,
  loadSpokenSeq,
  resolveCallSocketUrl,
  saveSeatToken,
  saveSpokenSeq,
} from '@/lib/callSession';

describe('resolveCallSocketUrl', () => {
  const page = (protocol: string, host: string) => ({
    protocol,
    host,
    hostname: host.split(':')[0],
  });

  it('本番のhttpsでは同一オリジンのwssにつなぐ', () => {
    expect(resolveCallSocketUrl(page('https:', 'echo.example.run.app'), undefined, false)).toBe(
      'wss://echo.example.run.app/ws/call',
    );
  });

  it('本番のhttpでは同一オリジンのwsにつなぐ', () => {
    expect(resolveCallSocketUrl(page('http:', 'localhost:8080'), undefined, false)).toBe(
      'ws://localhost:8080/ws/call',
    );
  });

  it('開発時は開いているホストの8080番につなぐ', () => {
    expect(resolveCallSocketUrl(page('http:', '192.168.0.10:3000'), undefined, true)).toBe(
      'ws://192.168.0.10:8080/ws/call',
    );
  });

  it('指定があればそれを使う', () => {
    expect(
      resolveCallSocketUrl(page('https:', 'a.example'), 'wss://b.example/ws/call', false),
    ).toBe('wss://b.example/ws/call');
  });
});

describe('席のトークンの保存', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('役割ごとに保存して読み出す', () => {
    saveSeatToken('patient', 'patient-seat');
    saveSeatToken('hospital', 'hospital-seat');

    expect(loadSeatToken('patient')).toBe('patient-seat');
    expect(loadSeatToken('hospital')).toBe('hospital-seat');
  });

  it('null で消す', () => {
    saveSeatToken('patient', 'patient-seat');

    saveSeatToken('patient', null);

    expect(loadSeatToken('patient')).toBeNull();
  });

  it('localStorage には保存しない', () => {
    saveSeatToken('patient', 'patient-seat');

    expect(window.localStorage.length).toBe(0);
  });

  it('保存できない環境でも例外を投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => saveSeatToken('patient', 'patient-seat')).not.toThrow();
    expect(loadSeatToken('patient')).toBeNull();
  });
});

describe('読み上げ位置の保存', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('同じ席の位置だけを読み出す', () => {
    saveSpokenSeq('seat-a', 4);

    expect(loadSpokenSeq('seat-a')).toBe(4);
    expect(loadSpokenSeq('seat-b')).toBe(0);
  });

  it('壊れた値は0として扱う', () => {
    window.sessionStorage.setItem('echobridge.hospital.spoken', '{broken');

    expect(loadSpokenSeq('seat-a')).toBe(0);
  });
});
