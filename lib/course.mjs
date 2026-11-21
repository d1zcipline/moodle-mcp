// Course traversal, HTML -> text, and on-disk dumps.
import path from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { stripUrlSecrets, scrub } from './http.mjs';

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  bull: '•',
  rarr: '→',
  times: '×',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(html = '') {
  if (!html) return '';
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeName(name = 'file') {
  const cleaned = String(name)
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned.slice(0, 120) || 'file';
  return safe.replace(/^\.+/, '_');
}

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Due dates render in MOODLE_TZ; the machine's zone is the default. */
export const DEFAULT_TIME_ZONE = (() => {
  const candidate = process.env.MOODLE_TZ || SYSTEM_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
    return candidate;
  } catch {
    return SYSTEM_TIME_ZONE;
  }
})();

export function fmtDate(ts, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  };
  const parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MOD_ICONS = {
  assign: '📝',
  resource: '📄',
  file: '📎',
  folder: '📁',
  url: '🔗',
  page: '📃',
  forum: '💬',
  quiz: '❓',
  label: '🏷️',
  book: '📚',
  lesson: '📘',
  video: '🎬',
  choice: '☑️',
  feedback: '📋',
  workshop: '🛠️',
  attendance: '🗓️',
};

export function allFiles(sections = []) {
  const out = [];
  for (const section of sections) {
    for (const mod of section.modules || []) {
      for (const c of mod.contents || []) {
        if (c.type !== 'file' || !c.fileurl) continue;
        out.push({
          section: section.name || `Section ${section.section}`,
          module: mod.name,
          modname: mod.modname,
          filename: c.filename,
          fileurl: stripUrlSecrets(c.fileurl),
          filesize: c.filesize,
          mimetype: c.mimetype,
          timemodified: c.timemodified,
        });
      }
    }
  }
  return out;
}

export function renderStructure(course, sections, assignments = []) {
  const byCm = new Map(assignments.map((a) => [String(a.cmid), a]));
  const lines = [];
  lines.push(`# ${course.fullname || course.shortname || `Course ${course.id}`}`);
  lines.push('');
  lines.push(`- course id: \`${course.id}\``);
  if (course.shortname) lines.push(`- short name: \`${course.shortname}\``);
  if (course.startdate) lines.push(`- starts: ${fmtDate(course.startdate)}`);
  lines.push('');

  for (const section of sections) {
    const title = section.name?.trim() || `Section ${section.section}`;
    lines.push(`## ${section.section}. ${title}`);
    if (section.summary) {
      const summary = htmlToText(section.summary);
      if (summary) lines.push('', summary);
    }
    lines.push('');
    for (const mod of section.modules || []) {
      const icon = MOD_ICONS[mod.modname] || '•';
      let line = `- ${icon} **${mod.name}** — \`${mod.modname}\``;
      if (byCm.has(String(mod.id))) {
        const a = byCm.get(String(mod.id));
        line += `, due: ${fmtDate(a.duedate)}`;
      }
      lines.push(line);
      const intro = htmlToText(mod.description || '');
      if (intro) lines.push(`  ${intro.split('\n').join('\n  ')}`);
      for (const c of mod.contents || []) {
        if (c.type === 'file') {
          lines.push(`  - 📎 ${c.filename} (${humanSize(c.filesize)})`);
        } else if (c.type === 'url' && c.fileurl) {
          lines.push(`  - 🔗 ${c.filename || stripUrlSecrets(c.fileurl)}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Skip re-downloading when the file on disk already matches the remote size. */
async function downloadIfNeeded(ws, fileurl, dest, expectedSize) {
  try {
    const st = await stat(dest);
    if (expectedSize && st.size === Number(expectedSize)) {
      return { path: dest, bytes: st.size, skipped: true };
    }
  } catch {
    /* not there yet */
  }
  const res = await ws.download(fileurl, dest);
  return { ...res, skipped: false };
}

/**
 * Download everything for a course into outDir.
 * Returns a machine-readable summary.
 */
export async function dumpCourse(ctx, courseid, { outDir, download = true, log = () => {} }) {
  const { ws } = ctx;
  const courses = await ws.courses();
  const course = courses.find((c) => String(c.id) === String(courseid));
  if (!course) {
    throw new Error(`Course ${courseid} is not among your courses (found ${courses.length})`);
  }

  const sections = await ws.courseContents(courseid);
  const courseAssignments = (await ws.assignments([courseid])).flatMap((c) => c.assignments || []);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'course.json'), JSON.stringify(scrub({ course, sections }), null, 2));
  await writeFile(
    path.join(outDir, 'structure.md'),
    renderStructure(course, sections, courseAssignments),
    'utf8',
  );

  const files = allFiles(sections);
  const downloaded = [];
  const skipped = [];
  const failed = [];

  if (download) {
    for (const f of files) {
      const sectionDir = sanitizeName(f.section);
      const dest = path.join(outDir, 'files', sectionDir, sanitizeName(f.filename));
      try {
        const res = await downloadIfNeeded(ws, f.fileurl, dest, f.filesize);
        (res.skipped ? skipped : downloaded).push({ ...f, path: dest, bytes: res.bytes });
        log(`  ${res.skipped ? '=' : '↓'} ${f.filename} (${humanSize(res.bytes)})`);
      } catch (err) {
        failed.push({ ...f, error: err.message });
        log(`  ✗ ${f.filename}: ${err.message}`);
      }
    }
  }

  const assignmentsOut = [];
  let attachmentsDownloaded = 0;
  for (const a of courseAssignments) {
    const dir = path.join(
      outDir,
      'assignments',
      `${a.cmid}-${sanitizeName(a.name).slice(0, 60)}`,
    );
    await mkdir(dir, { recursive: true });
    let status = null;
    try {
      status = await ws.submissionStatus(a.id);
    } catch (err) {
      status = { error: err.message };
    }

    // Attachments live on the assignment itself, not in the course sections.
    const attachments = [...(a.introattachments || []), ...(a.introfiles || [])];
    const attachmentOut = [];
    for (const f of attachments) {
      const dest = path.join(dir, 'files', sanitizeName(f.filename));
      try {
        const res = await downloadIfNeeded(ws, f.fileurl, dest, f.filesize);
        if (!res.skipped) attachmentsDownloaded++;
        attachmentOut.push({ filename: f.filename, filesize: f.filesize, path: dest });
        log(`  ${res.skipped ? '=' : '↓'} ${f.filename} (${humanSize(res.bytes)})`);
      } catch (err) {
        attachmentOut.push({ filename: f.filename, filesize: f.filesize, error: err.message });
        log(`  ✗ ${f.filename}: ${err.message}`);
      }
    }

    await writeFile(
      path.join(dir, 'assignment.json'),
      JSON.stringify(scrub({ assignment: a, status, attachments: attachmentOut }), null, 2),
    );
    const intro = htmlToText(a.intro || '');
    await writeFile(
      path.join(dir, 'intro.md'),
      [
        `# ${a.name}`,
        '',
        `- assignment id: \`${a.id}\`, cmid: \`${a.cmid}\``,
        `- due: ${fmtDate(a.duedate)}`,
        a.cutoffdate ? `- cutoff: ${fmtDate(a.cutoffdate)}` : null,
        a.allowsubmissionsfromdate
          ? `- open from: ${fmtDate(a.allowsubmissionsfromdate)}`
          : null,
        a.grade ? `- max grade: ${a.grade}` : null,
        '',
        intro || '_No description_',
        attachments.length ? '' : null,
        attachments.length ? 'Attachments:' : null,
        ...attachmentOut.map((f) => (f.error ? `- ✗ ${f.filename}: ${f.error}` : `- ${f.filename} (${humanSize(f.filesize)})`)),
        '',
      ]
        .filter((l) => l !== null)
        .join('\n'),
      'utf8',
    );
    assignmentsOut.push({
      cmid: a.cmid,
      id: a.id,
      name: a.name,
      duedate: a.duedate,
      dir,
      attachments: attachmentOut,
    });
  }

  const summary = {
    course: { id: course.id, fullname: course.fullname, shortname: course.shortname },
    outDir,
    sections: sections.length,
    modules: sections.reduce((n, s) => n + (s.modules?.length || 0), 0),
    files: files.length,
    downloaded: downloaded.length,
    skipped: skipped.length,
    failed: failed.length,
    assignments: assignmentsOut,
    attachmentsDownloaded,
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(scrub(summary), null, 2));
  return summary;
}

/** Resolve a course-module id (the `id=` in a Moodle URL) to its course/assignment. */
export async function resolveModule(ctx, cmid) {
  const { ws } = ctx;
  const cm = await ws.courseModule(cmid);
  if (!cm) throw new Error(`Course module ${cmid} not found`);
  const result = {
    cmid: cm.id,
    courseid: cm.course,
    modname: cm.modname,
    name: cm.name,
    instance: cm.instance,
    url: cm.url || null,
  };
  if (cm.modname === 'assign' && cm.instance) {
    const courses = await ws.assignments([cm.course]);
    const a = (courses[0]?.assignments || []).find((x) => String(x.id) === String(cm.instance));
    if (a) {
      result.assignment = scrub(a);
      result.status = await ws.submissionStatus(a.id).catch((e) => ({ error: e.message }));
    }
  }
  return result;
}
