#!/usr/bin/env node
// MCP (stdio) server exposing a Moodle site: courses, assignments, files.
// Read-only by design: there are no submission or upload tools.
//
// stdout is reserved for the MCP protocol — all diagnostics go to stderr.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { connect, ROOT } from './lib/auth.mjs';
import {
  dumpCourse,
  resolveModule,
  renderStructure,
  allFiles,
  htmlToText,
  fmtDate,
  humanSize,
  sanitizeName,
} from './lib/course.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

const DATA_DIR = process.env.MOODLE_DATA_DIR || path.join(ROOT, 'moodle-data');

function log(...a) {
  process.stderr.write(`[moodle-mcp] ${a.join(' ')}\n`);
}

// One session per process; re-created if Moodle invalidates the token.
let session = null;
let pending = null;

async function getSession() {
  if (session) return session;
  if (!pending) {
    pending = connect()
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

async function withSession(fn) {
  try {
    return await fn(await getSession());
  } catch (err) {
    if (err.errorcode && /invalidtoken|accessexception/i.test(err.errorcode)) {
      session = null;
      return fn(await getSession());
    }
    throw err;
  }
}

const TOOLS = [
  {
    name: 'moodle_whoami',
    description:
      'Signed-in user: full name, user id, site name/release and the number of API functions available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'moodle_courses',
    description:
      'List my enrolled courses as "id — fullname (shortname)". Start here: every other tool needs a course id or a module id taken from it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'moodle_course_structure',
    description:
      'Course outline as markdown: sections, every module (assignment, file, page, url) with its type, due dates and attached files. Use it to see what the course contains before downloading anything.',
    inputSchema: {
      type: 'object',
      properties: { courseid: { type: 'number', description: 'Course id from moodle_courses' } },
      required: ['courseid'],
      additionalProperties: false,
    },
  },
  {
    name: 'moodle_course_module',
    description:
      'One course module by cmid — the numeric id= in a Moodle URL such as /mod/assign/view.php?id=12345. Returns name, type, course id and, for assignments, the due date and description.',
    inputSchema: {
      type: 'object',
      properties: { cmid: { type: 'number', description: 'Course module id (id= from the URL)' } },
      required: ['cmid'],
      additionalProperties: false,
    },
  },
  {
    name: 'moodle_assignment',
    description:
      'Full assignment: description, due/cutoff dates, max grade, attachments with download URLs, and my submission status (new/draft/submitted, graded or not, can I still submit).',
    inputSchema: {
      type: 'object',
      properties: {
        cmid: { type: 'number', description: 'Course module id from the URL' },
        assignid: { type: 'number', description: 'Alternative: internal assignment id' },
        courseid: { type: 'number', description: 'Required together with assignid' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'moodle_list_files',
    description:
      'Every downloadable file in a course: section, module, filename, size and a direct fileurl. Pass that url to moodle_download_file.',
    inputSchema: {
      type: 'object',
      properties: { courseid: { type: 'number' } },
      required: ['courseid'],
      additionalProperties: false,
    },
  },
  {
    name: 'moodle_download_file',
    description:
      'Download one file into the local moodle-data/downloads folder and return its path. Takes a fileurl from moodle_list_files or an assignment attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'fileurl from moodle_list_files or moodle_assignment' },
        filename: { type: 'string', description: 'Override the filename (default: from the URL)' },
        subdir: { type: 'string', description: 'Subfolder inside moodle-data/downloads' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'moodle_dump_course',
    description:
      'Mirror a whole course to disk: structure.md, course.json, every file and every assignment with its description and attachments. Saved to moodle-data/<courseid>. Idempotent — already downloaded files are skipped by size.',
    inputSchema: {
      type: 'object',
      properties: {
        courseid: { type: 'number' },
        download: { type: 'boolean', description: 'Download files too (default true)' },
      },
      required: ['courseid'],
      additionalProperties: false,
    },
  },
];

function text(value) {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

const STATUS_LABELS = {
  new: 'not submitted',
  draft: 'draft',
  submitted: 'submitted',
  reopened: 'returned for revision',
};

/** Compact, human-readable submission status instead of raw Moodle JSON. */
function summarizeStatus(status) {
  const a = status?.lastattempt;
  if (!a) {
    return status?.error ? `_Submission status unavailable: ${status.error}_` : '_Submission status unavailable_';
  }
  const files = (a.submission?.plugins || [])
    .flatMap((p) => p.fileareas || [])
    .flatMap((f) => f.files || [])
    .map((f) => f.filename);
  return [
    `- status: ${STATUS_LABELS[a.submission?.status] || a.submission?.status || '—'}`,
    `- graded: ${a.graded ? 'yes' : 'no'}${a.grade ? ` (${a.grade.grade}/${a.grade.grademax})` : ''}`,
    `- can submit: ${a.cansubmit ? 'yes' : 'no'}${a.locked ? ' (locked)' : ''}`,
    `- submitted files: ${files.length ? files.join(', ') : 'none'}`,
  ].join('\n');
}

function summarizeAttachments(assignment) {
  const files = [...(assignment.introattachments || []), ...(assignment.introfiles || [])];
  if (!files.length) return null;
  return [
    '',
    'Attachments:',
    ...files.map((f) => `- ${f.filename} (${humanSize(f.filesize)})\n  ${f.fileurl}`),
  ].join('\n');
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'moodle_whoami':
      return withSession(async ({ info, http }) =>
        text(
          [
            `Name: ${info.fullname}`,
            `User id: ${info.userid}`,
            `Site: ${info.sitename} (${info.release || 'Moodle'})`,
            `API functions: ${(info.functions || []).length}`,
            `Socket: ${http.localAddress || 'not bound'}`,
          ].join('\n'),
        ),
      );

    case 'moodle_courses':
      return withSession(async ({ ws }) => {
        const list = await ws.courses();
        if (!list.length) return text('No courses found.');
        return text(
          list
            .map((c) => `- \`${c.id}\` — ${c.fullname}${c.shortname ? ` (${c.shortname})` : ''}`)
            .join('\n'),
        );
      });

    case 'moodle_course_structure':
      return withSession(async ({ ws }) => {
        const courseid = Number(args.courseid);
        const sections = await ws.courseContents(courseid);
        const course = (await ws.courses()).find((c) => c.id === courseid) || { id: courseid };
        const assignments = (await ws.assignments([courseid])).flatMap((c) => c.assignments || []);
        return text(renderStructure(course, sections, assignments));
      });

    case 'moodle_course_module':
      return withSession(async (ctx) => {
        const info = await resolveModule(ctx, Number(args.cmid));
        const lines = [
          `# ${info.name}`,
          `- cmid: \`${info.cmid}\``,
          `- type: ${info.modname}`,
          `- course: \`${info.courseid}\``,
        ];
        if (info.url) lines.push(`- link: ${info.url}`);
        if (info.assignment) {
          lines.push(`- due: ${fmtDate(info.assignment.duedate)}`);
          const intro = htmlToText(info.assignment.intro || '');
          if (intro) lines.push('', intro);
        }
        return text(lines.join('\n'));
      });

    case 'moodle_assignment':
      return withSession(async (ctx) => {
        const { ws } = ctx;
        let assignment = null;
        let status = null;
        if (args.cmid) {
          const info = await resolveModule(ctx, Number(args.cmid));
          assignment = info.assignment;
          status = info.status;
        } else if (args.assignid && args.courseid) {
          const courses = await ws.assignments([Number(args.courseid)]);
          assignment = (courses[0]?.assignments || []).find((a) => a.id === Number(args.assignid));
          if (assignment) {
            status = await ws.submissionStatus(assignment.id).catch((e) => ({ error: e.message }));
          }
        }
        if (!assignment) {
          return text('Assignment not found. Pass cmid, or assignid together with courseid.');
        }
        return text(
          [
            `# ${assignment.name}`,
            `- id: \`${assignment.id}\`, cmid: \`${assignment.cmid}\``,
            `- due: ${fmtDate(assignment.duedate)}`,
            assignment.cutoffdate ? `- cutoff: ${fmtDate(assignment.cutoffdate)}` : null,
            `- max grade: ${assignment.grade}`,
            '',
            htmlToText(assignment.intro || '') || '_No description_',
            '',
            summarizeStatus(status),
            summarizeAttachments(assignment),
          ]
            .filter((l) => l !== null)
            .join('\n'),
        );
      });

    case 'moodle_list_files':
      return withSession(async ({ ws }) => {
        const sections = await ws.courseContents(Number(args.courseid));
        const files = allFiles(sections);
        if (!files.length) return text('This course has no downloadable files.');
        return text(
          files
            .map(
              (f) =>
                `- [${humanSize(f.filesize)}] ${f.section} / **${f.filename}**\n  url: ${f.fileurl}`,
            )
            .join('\n'),
        );
      });

    case 'moodle_download_file':
      return withSession(async ({ ws }) => {
        const name = sanitizeName(
          args.filename || decodeURIComponent(String(args.url).split('/').pop() || 'file'),
        );
        const subdir = args.subdir ? sanitizeName(args.subdir) : '';
        const dest = path.join(DATA_DIR, 'downloads', subdir, name);
        const res = await ws.download(String(args.url), dest);
        return text(`Downloaded: ${res.path} (${humanSize(res.bytes)})`);
      });

    case 'moodle_dump_course':
      return withSession(async (ctx) => {
        const courseid = Number(args.courseid);
        const outDir = path.join(DATA_DIR, String(courseid));
        const summary = await dumpCourse(ctx, courseid, {
          outDir,
          download: args.download !== false,
        });
        return text(
          [
            `Course dumped: ${summary.course.fullname}`,
            `- folder: ${outDir}`,
            `- sections: ${summary.sections}, modules: ${summary.modules}`,
            `- files: ${summary.files}, downloaded: ${summary.downloaded}, skipped: ${summary.skipped}, failed: ${summary.failed}`,
            `- assignments: ${summary.assignments.length}`,
            `- structure: ${path.join(outDir, 'structure.md')}`,
          ].join('\n'),
        );
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server({ name: 'moodle', version: pkg.version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, args || {});
  } catch (err) {
    log('tool failed', name, err.message);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log('ready');
