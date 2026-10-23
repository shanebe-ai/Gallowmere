import { query } from '../db/pool.js';

export const MAX_NOTES = 10;
export const MAX_SUMMARY = 400;

export interface Memory {
  notes: string[];
  summary: string;
}

export async function getMemory(npcId: string, playerId: number): Promise<Memory> {
  const { rows } = await query<{ notes: string[]; summary: string }>(
    'SELECT notes, summary FROM npc_memory WHERE npc_id=$1 AND player_id=$2',
    [npcId, playerId],
  );
  return rows[0] ?? { notes: [], summary: '' };
}

/** Adds a note; once past MAX_NOTES the oldest notes fold into the summary. */
export function foldNote(mem: Memory, note: string): Memory {
  const notes = [...mem.notes, note];
  let summary = mem.summary;
  while (notes.length > MAX_NOTES) {
    const oldest = notes.shift()!;
    summary = summary ? `${summary}; ${oldest}` : oldest;
  }
  if (summary.length > MAX_SUMMARY) summary = summary.slice(summary.length - MAX_SUMMARY).replace(/^[^;]*;\s*/, '');
  return { notes, summary };
}

export async function addNote(npcId: string, playerId: number, note: string): Promise<Memory> {
  const next = foldNote(await getMemory(npcId, playerId), note);
  await query(
    `INSERT INTO npc_memory (npc_id, player_id, notes, summary, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (npc_id, player_id) DO UPDATE SET notes=$3, summary=$4, updated_at=now()`,
    [npcId, playerId, next.notes, next.summary],
  );
  return next;
}
