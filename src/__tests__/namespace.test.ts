import { describe, it, expect } from 'vitest';
import { detectNamespace } from '../namespace.js';

// ── Namespace Auto-Detection ───────────────────────────────────────────────

describe('detectNamespace', () => {
  // ── Code ────────────────────────────────────────────────────────────────────
  describe('code detection', () => {
    it.each([
      ['python def',        'def process(data): return data * 2'],
      ['js const arrow',    'const handler = () => response.send(200)'],
      ['ts class',          'class UserService { constructor(private repo: Repo) {} }'],
      ['import statement',  'import { useState } from "react"'],
      ['shebang line',      '#!/usr/bin/env python3\nprint("hello")'],
      ['go func',           'func main() { fmt.Println("hello") }'],
      ['cpp include',       '#include <iostream>\nint main() { return 0; }'],
      ['interface block',   'interface ICache { get(key: string): void; }'],
      ['struct block',      'struct Config { host string }'],
      ['async def',         'async def fetch_data(url: str) -> dict:'],
      ['lambda',            'fn = lambda x: x * 2'],
      ['package decl',      'package com.example.service;'],
    ])('detects code: %s', (_, prompt) => {
      expect(detectNamespace(prompt)).toBe('cachly:sem:code');
    });
  });

  // ── Translation ─────────────────────────────────────────────────────────────
  describe('translation detection', () => {
    it.each([
      ['translate',         'translate this paragraph to Spanish'],
      ['übersetze',         'übersetze diesen Text bitte'],
      ['auf deutsch',       'Schreib das auf deutsch'],
      ['in english',        'Please write this in english'],
      ['ins deutsche',      'Bitte übersetze ins Deutsche'],
      ['traduce',           'traduce este texto al alemán'],
      ['traduis',           'traduis ce texte en anglais'],
      ['vertaal',           'vertaal dit naar het Nederlands'],
    ])('detects translation: %s', (_, prompt) => {
      expect(detectNamespace(prompt)).toBe('cachly:sem:translation');
    });
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  describe('summary detection', () => {
    it.each([
      ['summarize',         'summarize this article for me'],
      ['summarise',         'summarise the key points'],
      ['tl;dr',             'tl;dr of the following blog post:'],
      ['tldr',              'tldr of this document'],
      ['key points',        'what are the key points?'],
      ['zusammenfass',      'fasse zusammen worum es geht'],
      ['give me a brief',   'give me a brief overview'],
      ['in a nutshell',     'explain machine learning in a nutshell'],
      ['stichpunkte',       'Gib mir die wichtigsten Stichpunkte'],
    ])('detects summary: %s', (_, prompt) => {
      expect(detectNamespace(prompt)).toBe('cachly:sem:summary');
    });
  });

  // ── Q&A ──────────────────────────────────────────────────────────────────────
  describe('qa detection', () => {
    it.each([
      ['what is',           'what is the capital of France?'],
      ['how does',          'how does photosynthesis work?'],
      ['why is',            'why is the sky blue?'],
      ['who invented',      'who invented the internet?'],
      ['where is',          'where is Mount Everest located?'],
      ['when was',          'when was the Eiffel Tower built?'],
      ['can you',           'can you explain recursion?'],
      ['is redis',          'is Redis single-threaded?'],
      ['does postgres',     'does postgres support JSON natively?'],
      ['wer ist',           'wer ist der aktuelle Bundeskanzler?'],
      ['wie funktioniert',  'wie funktioniert ein JWT Token?'],
      ['trailing ?',        'Redis vs Memcached?'],
    ])('detects q&a: %s', (_, prompt) => {
      expect(detectNamespace(prompt)).toBe('cachly:sem:qa');
    });
  });

  // ── Creative ─────────────────────────────────────────────────────────────────
  describe('creative fallback', () => {
    it.each([
      ['poem request',     'Write a short poem about autumn leaves'],
      ['story request',    'Tell me a fantasy story about dragons'],
      ['product copy',     'Generate a product description for running shoes'],
      ['greeting',         'Good morning, how are you today'],
      ['general task',     'Help me brainstorm names for my startup'],
    ])('falls back to creative: %s', (_, prompt) => {
      expect(detectNamespace(prompt)).toBe('cachly:sem:creative');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('is case-insensitive', () => {
      expect(detectNamespace('CONST x = 1')).toBe('cachly:sem:code');
      expect(detectNamespace('TRANSLATE THIS')).toBe('cachly:sem:translation');
      expect(detectNamespace('SUMMARIZE PLEASE')).toBe('cachly:sem:summary');
      expect(detectNamespace('WHAT IS GRAVITY?')).toBe('cachly:sem:qa');
    });

    it('trims surrounding whitespace', () => {
      expect(detectNamespace('   what is Redis?   ')).toBe('cachly:sem:qa');
      expect(detectNamespace('  const x = 1  ')).toBe('cachly:sem:code');
    });

    it('code keyword takes priority over translation', () => {
      // Both "translate" and "def" present – code wins (checked first)
      expect(detectNamespace('translate this function: def foo(): pass')).toBe('cachly:sem:code');
    });

    it('code keyword takes priority over summary', () => {
      expect(detectNamespace('summarize this class MyService { }'))
        .toBe('cachly:sem:code');
    });

    it('handles empty string as creative', () => {
      expect(detectNamespace('')).toBe('cachly:sem:creative');
    });

    it('a single ? at end is qa', () => {
      expect(detectNamespace('Interesting concept?')).toBe('cachly:sem:qa');
    });
  });
});

