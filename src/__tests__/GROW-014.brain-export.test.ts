import { describe, it, expect } from 'vitest';
import { buildLessonsMarkdown, buildLessonsJsonl, type ExportLesson } from '../brain-export.js';

describe('GROW-014 brain-export — buildLessonsMarkdown', () => {
  it('leeres Brain liefert eine klare leere Ausgabe statt abzustuerzen', () => {
    const md = buildLessonsMarkdown([]);
    expect(md).toContain('No lessons yet');
    expect(md).not.toContain('##');
  });

  it('eine Lektion wird vollstaendig mit Ergebnis, Schwere, Datum und Dateien dargestellt', () => {
    const lesson: ExportLesson = {
      topic: 'docker:port-conflict',
      outcome: 'success',
      severity: 'major',
      whatWorked: 'Bind on a different host port.',
      ts: '2026-08-01T12:00:00Z',
      filePaths: ['api/main.go', 'api/config.go'],
      author: 'heinrich',
    };
    const md = buildLessonsMarkdown([lesson]);
    expect(md).toContain('### docker:port-conflict');
    expect(md).toContain('**Outcome:** success');
    expect(md).toContain('**Severity:** major');
    expect(md).toContain('**Date:** 2026-08-01T12:00:00Z');
    expect(md).toContain('**Files:** api/main.go, api/config.go');
    expect(md).toContain('Bind on a different host port.');
  });

  it('Sonderzeichen im Text zerbrechen das Markdown nicht', () => {
    const lesson: ExportLesson = {
      topic: 'weird:chars',
      whatWorked: 'Contains `code`, a | pipe, a # heading marker, *stars*, emoji \u{1F9E0} and\nan embedded newline.',
      whatFailed: 'Also <html> tags and "quotes".',
    };
    expect(() => buildLessonsMarkdown([lesson])).not.toThrow();
    const md = buildLessonsMarkdown([lesson]);
    expect(md).toContain('### weird:chars');
    expect(md).toContain('a # heading marker');
    expect(md).toContain('Also <html> tags and "quotes".');
  });

  it('mehrere Themen werden nach Kategorie gruppiert', () => {
    const lessons: ExportLesson[] = [
      { topic: 'docker:port-conflict' },
      { topic: 'docker:volume-missing' },
      { topic: 'ci:flaky-e2e' },
      { topic: 'no-category-here' },
    ];
    const md = buildLessonsMarkdown(lessons);
    expect(md).toContain('## ci');
    expect(md).toContain('## docker');
    expect(md).toContain('## Ungrouped');
    const dockerIdx = md.indexOf('## docker');
    const ciIdx = md.indexOf('## ci');
    expect(ciIdx).toBeLessThan(dockerIdx);
  });
});

describe('GROW-014 brain-export — buildLessonsJsonl', () => {
  it('leeres Brain liefert eine leere Zeichenkette, keine leere Datei mit Muell', () => {
    expect(buildLessonsJsonl([])).toBe('');
  });

  it('eine Lektion wird als eine gueltige JSON-Zeile mit snake_case-Feldern geschrieben', () => {
    const lesson: ExportLesson = {
      topic: 'docker:port-conflict',
      outcome: 'success',
      severity: 'major',
      whatWorked: 'Bind on a different host port.',
      whatFailed: 'Nothing failed.',
      filePaths: ['api/main.go'],
      tags: ['docker', 'ports'],
      ts: '2026-08-01T12:00:00Z',
      author: 'heinrich',
      recallCount: 3,
    };
    const jsonl = buildLessonsJsonl([lesson]);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.topic).toBe('docker:port-conflict');
    expect(parsed.what_worked).toBe('Bind on a different host port.');
    expect(parsed.what_failed).toBe('Nothing failed.');
    expect(parsed.file_paths).toEqual(['api/main.go']);
    expect(parsed.recall_count).toBe(3);
  });

  it('Sonderzeichen im Text bleiben in der JSONL-Zeile gueltiges JSON', () => {
    const lesson: ExportLesson = {
      topic: 'weird:chars',
      whatWorked: 'Line one\nLine two with "quotes" and a \\ backslash and emoji \u{1F9E0}.',
    };
    const jsonl = buildLessonsJsonl([lesson]);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.what_worked).toContain('Line one\nLine two');
  });

  it('mehrere Lektionen ergeben mehrere Zeilen in der urspruenglichen Reihenfolge', () => {
    const lessons: ExportLesson[] = [
      { topic: 'a:first' },
      { topic: 'b:second' },
      { topic: 'c:third' },
    ];
    const jsonl = buildLessonsJsonl(lessons);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0]) as Record<string, unknown>).topic).toBe('a:first');
    expect((JSON.parse(lines[2]) as Record<string, unknown>).topic).toBe('c:third');
  });
});
