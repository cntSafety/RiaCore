/*
 * Copyright (c) Samir Sarkic and Simon Roth
 *
 * This file is part of RiaCore.
 *
 * RiaCore is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */
/**
 * The Store-or-Load decision, drawn.
 *
 * Prose can state that the database was loaded from one snapshot and the files
 * on disk are now a different one, but the relationship is spatial and reads far
 * faster as a picture: two branch timelines, one database between them that
 * belongs to neither, and two arrows asking which way the content should move.
 *
 * Labelled with the REAL git state (branch names and short commit ids) rather
 * than placeholders, so the user recognises their own situation instead of
 * having to map an abstract diagram onto it.
 *
 * Degrades on purpose: outside a git repository there are no branches or commits
 * to name, so the two sides become "when opened" and "on disk now" and the commit
 * chips disappear. The shape of the decision is identical.
 *
 * ## Every timestamp is an event
 *
 * Three moments appear here, and each one is rendered as a verb plus a time,
 * never a time alone. A bare moment is read as whatever the reader was already
 * thinking about: placed under a commit chip it becomes the commit's date, and
 * given no verb it becomes whichever event seemed likely. Both misreadings were
 * reported against earlier versions of this diagram, which showed "changed" for
 * a git checkout and "saved" for what could equally have been a load.
 *
 * So each moment states what happened, and — where it moved content — the arrow
 * drawn for it points the way the content actually went:
 *
 *   opened / created    `openedAt`, the session clock. No content crossed.
 *   saved / loaded /    `syncedAt` + `syncedReason`. The reason is transported
 *   repaired / synced   from the backend because nothing can re-derive it.
 *   switched to /       `filesChangedAt`, derived here by comparing the two
 *   updated /           branch and commit pairs: git can tell a branch switch
 *   rewritten           from a commit move from an in-place rewrite.
 *
 * A verb is only ever claimed when the data supports it. With no reason the
 * label degrades to the neutral "synced" and the arrow keeps its default
 * direction rather than asserting one.
 */
import { theme } from 'antd';
import type { SnapshotSyncReason } from '@riacore/app-contracts';

const { useToken } = theme;

interface Props {
  /** Branch the DB content came from; null outside a repository. */
  dbBranch: string | null;
  /** Branch checked out now; null outside a repository. */
  diskBranch: string | null;
  /** Commit the DB content was loaded at. */
  dbCommit: string | null;
  /** Commit checked out now. */
  diskCommit: string | null;
  /** When the session began. */
  openedAt: string | null;
  /** When the database and the files last agreed (open, or the most recent save). */
  syncedAt: string | null;
  /** Which event stamped `syncedAt`; null when the stamp did not say. */
  syncedReason: SnapshotSyncReason | null;
  /** When the files on disk were last written. */
  filesChangedAt: string | null;
}

/** Keep long branch names from overflowing — SVG text does not wrap or ellipsise. */
function truncate(value: string, max = 22): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Git's own conventional short form. */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Date and clock time to the second, always both.
 *
 * Previously the date was dropped for moments earlier today, which is the common
 * case and reads fine in isolation — but these three moments are compared
 * against each other, and a reader cannot tell a qualified label from an
 * unqualified one without noticing what is absent. Seconds matter for the same
 * reason: a save and the `git discard` that undid it frequently land in the same
 * minute, and two events rendered "15:50" and "15:50" look like one event.
 */
function formatMoment(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  return `${day} ${time}`;
}

/** Two moments are "the same" if they are within a couple of seconds. */
function sameMoment(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 2000;
}

/**
 * A verb and the moment it happened, stacked.
 *
 * Two lines rather than one because a full date with seconds is roughly twice
 * the width of the verb beside it, and SVG text neither wraps nor ellipsises —
 * inline, the right-hand label ran past the viewBox edge. Stacking also lets the
 * timestamp take a smaller size, so the verb reads first and the precise moment
 * is there when wanted rather than competing for attention.
 */
function EventLabel({
  x, y, anchor, fill, verb, moment,
}: {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  fill: string;
  verb: string;
  moment: string | null;
}) {
  return (
    <>
      <text x={x} y={y} textAnchor={anchor} fontSize={11} fill={fill}>
        {verb}
      </text>
      {moment && (
        <text x={x} y={y + 13} textAnchor={anchor} fontSize={9} fill={fill} opacity={0.85}>
          {moment}
        </text>
      )}
    </>
  );
}

/** A stack of three offset sheets, representing the ria-data JSON files. */
function FileStack({ x, y, color, fill }: { x: number; y: number; color: string; fill: string }) {
  return (
    <g>
      {[4, 2, 0].map((offset) => (
        <rect
          key={offset}
          x={x + offset}
          y={y - offset}
          width={26}
          height={32}
          rx={2}
          fill={fill}
          stroke={color}
          strokeWidth={1.5}
        />
      ))}
    </g>
  );
}

/** A database cylinder. */
function Cylinder({ x, y, color, fill }: { x: number; y: number; color: string; fill: string }) {
  const w = 54;
  const h = 46;
  const ry = 8;
  return (
    <g>
      <path
        d={`M ${x} ${y + ry} L ${x} ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L ${x + w} ${y + ry}`}
        fill={fill}
        stroke={color}
        strokeWidth={1.5}
      />
      <ellipse cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} fill={fill} stroke={color} strokeWidth={1.5} />
    </g>
  );
}

export function SnapshotDriftDiagram({
  dbBranch, diskBranch, dbCommit, diskCommit,
  openedAt, syncedAt, syncedReason, filesChangedAt,
}: Props) {
  const { token } = useToken();

  const blue = token.colorPrimary;
  const orange = token.colorWarning;
  /**
   * The undecided direction. A third hue, deliberately not blue (the database's
   * own colour) and not orange (what happened TO the files), because the two
   * dashed arrows are the only things on this diagram that have not happened yet
   * — they are the question being asked. Taken from the antd preset palette so
   * it tracks the light/dark theme instead of being pinned to one background.
   */
  const purple = token.purple;
  const text = token.colorText;
  const dim = token.colorTextSecondary;
  const bg = token.colorBgContainer;

  const inRepo = Boolean(dbBranch || diskBranch);
  const leftTitle = dbBranch ? truncate(dbBranch) : 'when opened';
  const rightTitle = diskBranch ? truncate(diskBranch) : 'on disk now';
  const leftSha = shortSha(dbCommit);
  const rightSha = shortSha(diskCommit);

  const openedLabel = formatMoment(openedAt);
  const changedLabel = formatMoment(filesChangedAt);
  /**
   * The sync event: when the database and the files last agreed, and what did it.
   *
   * Only rendered as its own step when something moved the baseline AFTER the
   * open. An open stamps `syncedAt === openedAt`, so showing both would print the
   * same moment twice under two different verbs.
   */
  const syncIsTheOpen = syncedReason === 'open' || syncedReason === 'create'
    // No reason recorded: fall back to comparing the moments, which is what this
    // did before the reason was transported.
    || (syncedReason === null && sameMoment(openedAt, syncedAt));
  const syncMovedAfterOpen = Boolean(syncedAt) && !syncIsTheOpen;
  const syncedLabel = syncMovedAfterOpen ? formatMoment(syncedAt) : null;

  const syncedVerbs: Record<SnapshotSyncReason, string> = {
    store: 'saved',
    load: 'loaded',
    repair: 'repaired',
    open: 'opened',
    create: 'created',
  };
  // No reason recorded: stay neutral rather than guess a verb.
  const syncedVerb = syncedReason ? syncedVerbs[syncedReason] : 'synced';

  /**
   * Which way the content moved, and therefore which way the step-1 arrow points.
   *
   * A store wrote the database OUT to these files; everything else either brought
   * them in or moved nothing. Drawing a store as files → database — which is what
   * this diagram did before the reason was transported — tells the user the
   * database came from a snapshot that its own save had already replaced, and
   * points them at the wrong recovery direction.
   *
   * 'repair' moves no content (it recomputes `manifest.json` from the files), and
   * nor does 'create'. Both keep the default orientation rather than growing a
   * third arrow style for a case the user will essentially never see here: a
   * repair is rare, and a brand-new workspace has no manifest to drift from.
   */
  const syncWroteFilesFromDb = syncedReason === 'store';

  /**
   * What happened, named as precisely as the data allows.
   *
   * The generic "git state changed" reads as nonsense in the undo case, where
   * both sides sit on the same branch AND the same commit — the arrow appeared to
   * claim a change that git itself cannot see. The files were rewritten inside one
   * commit, which is a different event and deserves different words.
   */
  const driftKind: 'no-repo' | 'branch' | 'commit' | 'worktree' = (() => {
    if (!inRepo) return 'no-repo';
    if (dbBranch && diskBranch && dbBranch !== diskBranch) return 'branch';
    if (dbCommit && diskCommit && dbCommit !== diskCommit) return 'commit';
    // Same branch, same commit: a working-tree change — typically git restore /
    // checkout -- / stash, i.e. an uncommitted save being undone.
    return 'worktree';
  })();

  const stepTwoLabel = {
    'no-repo': '2. the files changed on disk',
    branch: '2. switched branch',
    commit: '2. pulled or reset to another commit',
    worktree: '2. files rewritten — same commit, e.g. git discard',
  }[driftKind];

  /**
   * The timestamp beside the on-disk commit is a manifest mtime: when these files
   * landed in the working tree, not when the commit was authored or when its
   * content last meaningfully changed. Read as a bare "changed", it looks like a
   * property of the commit chip above it, which invited exactly the wrong
   * conclusion. Naming the event that wrote them keeps it a property of the
   * working tree — and for a branch switch, "switched to" says so outright.
   */
  const changedVerb = {
    'no-repo': 'changed',
    branch: 'switched to',
    commit: 'updated',
    worktree: 'rewritten',
  }[driftKind];

  // Geometry. Two vertical timelines with the database between them.
  const leftX = 74;
  const rightX = 436;
  const dbX = 226;

  return (
    <svg
      /* Right margin sized for the widest on-disk label: a start-anchored verb
         over a full date with seconds, where "Sept" is the longest month
         abbreviation en-GB produces. SVG text does not ellipsise, so a label
         that outgrows the viewBox is simply clipped. */
      viewBox="0 0 580 248"
      width="100%"
      role="img"
      aria-label={
        inRepo
          ? `The database holds ria-data from branch ${dbBranch ?? 'unknown'}; branch ${diskBranch ?? 'unknown'} is checked out now. Choose to store to or load from the files on disk.`
          : 'The database holds the ria-data it was opened with; the files on disk have since changed. Choose to store to or load from the files on disk.'
      }
      style={{ display: 'block', margin: '4px 0 12px' }}
    >
      <defs>
        <marker id="drift-arrow-blue" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={blue} />
        </marker>
        {/* Marker units scale with stroke-width by default, so the step-2 head is
            sized DOWN here to stay in proportion to its much thicker line. */}
        <marker id="drift-arrow-orange-heavy" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={orange} />
        </marker>
        <marker id="drift-arrow-purple" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={purple} />
        </marker>
      </defs>

      {/* ── Branch timelines ──────────────────────────────────────────────── */}
      <line x1={leftX + 13} y1={84} x2={leftX + 13} y2={238} stroke={blue} strokeWidth={2} />
      <line x1={rightX + 13} y1={84} x2={rightX + 13} y2={238} stroke={orange} strokeWidth={2} />

      {/* ── Headings ─────────────────────────────────────────────────────── */}
      {/* The step-2 arrow sits BELOW these rather than beside them: a long branch
          name and the arrow's caption occupy the same horizontal band, and SVG
          text neither wraps nor ellipsises, so side-by-side collided. */}
      <text x={leftX + 13} y={26} textAnchor="middle" fontSize={12} fontWeight={600} fill={text}>
        ria-data
      </text>
      <text x={leftX + 13} y={44} textAnchor="middle" fontSize={12} fill={blue}>
        {inRepo ? `branch ${leftTitle}` : leftTitle}
      </text>

      <text x={rightX + 13} y={26} textAnchor="middle" fontSize={12} fontWeight={600} fill={text}>
        ria-data
      </text>
      <text x={rightX + 13} y={44} textAnchor="middle" fontSize={12} fill={orange}>
        {inRepo ? `branch ${rightTitle}` : rightTitle}
      </text>

      {/* ── Step 2: the git state change, across the top ─────────────────── */}
      {/* Drawn heavy on purpose. This is the only event on the diagram the user
          did not perform from inside RiaCore, and it is the cause of everything
          below it — at the same weight as the other arrows it read as one
          step among equals, which is how "rewritten" came to look like something
          the database had done. */}
      <text x={(leftX + rightX) / 2 + 13} y={66} textAnchor="middle" fontSize={11} fontWeight={600} fill={text}>
        {stepTwoLabel}
      </text>
      <line
        x1={leftX + 13} y1={80} x2={rightX + 6} y2={80}
        stroke={orange} strokeWidth={5} markerEnd="url(#drift-arrow-orange-heavy)"
      />

      {/* ── Left: the snapshot the DB was built from ─────────────────────── */}
      <FileStack x={leftX} y={116} color={blue} fill={bg} />
      {/* Commit only. The sync moment belongs on the step-1 arrow, where it can
          say which event it was and which way the content went; stacked under the
          commit id it read as the commit's own date. */}
      {leftSha && (
        <text x={leftX - 8} y={136} textAnchor="end" fontSize={11} fill={dim}>
          {leftSha}
        </text>
      )}

      {/* ── Centre: the database, in neither branch ──────────────────────── */}
      <Cylinder x={dbX} y={120} color={blue} fill={bg} />
      <text x={dbX + 27} y={108} textAnchor="middle" fontSize={12} fontWeight={600} fill={text}>
        RiaCore database
      </text>
      <text x={dbX + 27} y={188} textAnchor="middle" fontSize={11} fill={dim}>
        not in git
      </text>
      {/* The session clock, shown here only when step 1 is no longer the open —
          otherwise the same moment would appear twice. It belongs to the
          database, which is the thing that was opened. */}
      {syncMovedAfterOpen && openedLabel && (
        <EventLabel
          x={dbX + 27} y={204} anchor="middle" fill={dim}
          verb="opened" moment={openedLabel}
        />
      )}

      {/* 1. the event that put this content in the database, pointing the way the
             content actually moved. */}
      <line
        x1={leftX + 30} y1={132} x2={dbX - 6} y2={138}
        stroke={blue} strokeWidth={1.5}
        {...(syncWroteFilesFromDb
          ? { markerStart: 'url(#drift-arrow-blue)' }
          : { markerEnd: 'url(#drift-arrow-blue)' })}
      />
      <EventLabel
        x={(leftX + 30 + dbX) / 2 - 6} y={110} anchor="middle" fill={dim}
        verb={syncedLabel ? `1. ${syncedVerb}` : '1. opened'}
        moment={syncedLabel ?? openedLabel}
      />

      {/* ── Right: what is on disk now ───────────────────────────────────── */}
      {/* Level with the left stack, not below it. Sitting lower and downstream of
          the database, it read as a thing the database had produced — so
          "rewritten" looked like RiaCore's own doing rather than an external
          write. Side by side at the same height, the two stacks are what they
          actually are: two peer snapshots of the same files, and the only arrow
          reaching this one comes from step 2 above. */}
      <FileStack x={rightX} y={116} color={orange} fill={bg} />
      {rightSha && (
        <text x={rightX + 40} y={126} textAnchor="start" fontSize={11} fill={dim}>
          {rightSha}
        </text>
      )}
      <EventLabel
        x={rightX + 40} y={142} anchor="start" fill={dim}
        verb={changedVerb} moment={changedLabel}
      />

      {/* ── The decision: dashed, because neither has happened ───────────── */}
      {/* Dashed and purple to separate what the user may choose from what has
          already occurred. Every solid arrow here is history; these two are the
          question. */}
      {/* Store: database → files on disk */}
      <line
        x1={dbX + 62} y1={140} x2={rightX - 6} y2={126}
        stroke={purple} strokeWidth={1.5} strokeDasharray="5 4"
        markerEnd="url(#drift-arrow-purple)"
      />
      <text x={(dbX + 62 + rightX) / 2} y={118} textAnchor="middle" fontSize={11} fontWeight={600} fill={text}>
        Store to ria-data?
      </text>

      {/* Load: files on disk → database */}
      <line
        x1={rightX - 6} y1={150} x2={dbX + 62} y2={164}
        stroke={purple} strokeWidth={1.5} strokeDasharray="5 4"
        markerEnd="url(#drift-arrow-purple)"
      />
      <text x={(dbX + 62 + rightX) / 2} y={182} textAnchor="middle" fontSize={11} fontWeight={600} fill={text}>
        … or load from ria-data?
      </text>
    </svg>
  );
}
