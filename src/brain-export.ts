/**
 * Turns raw Brain lessons into the two files `cachly export` writes: a
 * human-readable Markdown dump and a machine-readable JSONL dump. Pure by
 * design — no network, no filesystem. The `export` CLI command in index.ts
 * fetches the lessons and writes the files these functions build.
 */

/**
 * One lesson as exported from the Brain. Only `topic` is required — every
 * other field is optional because not every lesson (or every API response)
 * carries all of them, and a missing field must never crash the export.
 */
export interface ExportLesson {
  topic: string;
  outcome?: string;
  severity?: string;
  whatWorked?: string;
  whatFailed?: string;
  filePaths?: string[];
  tags?: string[];
  ts?: string;
  author?: string;
  recallCount?: number;
}

const UNGROUPED_HEADING = 'Ungrouped';

function groupByCategory(lessons: ExportLesson[]): Map<string, ExportLesson[]> {
  const groups = new Map<string, ExportLesson[]>();
  for (const lesson of lessons) {
    const colonIdx = lesson.topic.indexOf(':');
    const category = colonIdx > 0 ? lesson.topic.slice(0, colonIdx) : UNGROUPED_HEADING;
    const bucket = groups.get(category);
    if (bucket) {
      bucket.push(lesson);
    } else {
      groups.set(category, [lesson]);
    }
  }
  return groups;
}

function renderLesson(lesson: ExportLesson): string {
  const fields: string[] = [];
  if (lesson.outcome) fields.push(`- **Outcome:** ${lesson.outcome}`);
  if (lesson.severity) fields.push(`- **Severity:** ${lesson.severity}`);
  if (lesson.ts) fields.push(`- **Date:** ${lesson.ts}`);
  if (lesson.filePaths && lesson.filePaths.length > 0) fields.push(`- **Files:** ${lesson.filePaths.join(', ')}`);
  if (lesson.author) fields.push(`- **Author:** ${lesson.author}`);
  if (lesson.tags && lesson.tags.length > 0) fields.push(`- **Tags:** ${lesson.tags.join(', ')}`);

  const body: string[] = [];
  if (lesson.whatWorked) body.push(lesson.whatWorked);
  if (lesson.whatFailed) body.push(`**What failed:** ${lesson.whatFailed}`);

  return [`### ${lesson.topic}`, '', ...fields, '', ...body].join('\n').trimEnd();
}

/**
 * Builds the human-readable Markdown dump: one `##` section per topic
 * category (the part of `topic` before the first `:`, or "Ungrouped" when
 * there is none), one `###` subsection per lesson listing outcome, severity,
 * date and files. Never throws — an empty list renders a plain "no lessons
 * yet" line instead of an empty document, and any text in a lesson (however
 * unusual) is written as-is without breaking the surrounding structure.
 */
export function buildLessonsMarkdown(lessons: ExportLesson[]): string {
  if (lessons.length === 0) {
    return '# Your Cachly Brain\n\nNo lessons yet — nothing to export.\n';
  }

  const groups = groupByCategory(lessons);
  const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const sections = categories.map((category) => {
    const entries = groups.get(category)!.map(renderLesson).join('\n\n');
    return `## ${category}\n\n${entries}`;
  });

  const count = lessons.length;
  const heading = `# Your Cachly Brain\n\n${count} lesson${count === 1 ? '' : 's'}, grouped by topic.`;
  return [heading, ...sections].join('\n\n') + '\n';
}

/**
 * Builds the machine-readable JSONL dump: one JSON object per line, one
 * line per lesson, snake_case keys matching `learn_from_attempts` so the
 * file can be grepped, jq'd or re-imported without a schema lookup. Fields
 * that are absent on a lesson are simply omitted from its line. An empty
 * list returns an empty string (a zero-line file), never throws.
 */
export function buildLessonsJsonl(lessons: ExportLesson[]): string {
  if (lessons.length === 0) return '';
  return lessons.map((lesson) => JSON.stringify({
    topic: lesson.topic,
    outcome: lesson.outcome,
    severity: lesson.severity,
    what_worked: lesson.whatWorked,
    what_failed: lesson.whatFailed,
    file_paths: lesson.filePaths,
    tags: lesson.tags,
    ts: lesson.ts,
    author: lesson.author,
    recall_count: lesson.recallCount,
  })).join('\n') + '\n';
}
