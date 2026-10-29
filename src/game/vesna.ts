// The gate of Vesna (Milestone 4 step 5): a three step quest that is all code.
// The voice behind the hatch and the people asked along the way are performed, but
// every check (a clean name, a letter, a sealed parcel, the right answer) is the engine's.

import { query } from '../db/pool.js';
import { createItem, deleteItem, getFlag, setFlag, tx } from './economy.js';
import { c } from './text.js';
import type { Game } from './game.js';
import type { Session } from './session.js';
import type { Exit, Room } from './world.js';

export const GATE = 'shut_gate';
export const WARD = 'vesna_yard';
const LETTER = 'letter_of_passage';
const PARCEL = 'sealed_parcel';
const TORN = 'torn_parcel';
const RIDDLE =
  'Through the hatch, slowly: "I have a mouth and never speak, a bed and never sleep, ' +
  'I run all day and never walk, and your town sits on my bank. What am I?" Answer with: answer <words>.';
const RIDDLE_RETRY_MS = 60 * 60_000;
const PARCEL_RETRY_MS = 24 * 60 * 60_000;

/** Quest stages, stored per player in the 'vesna' flag. */
export type Stage = '' | 'asked' | 'letter' | 'parcel' | 'riddle' | 'open';

/** Does this answer the riddle? A river, however it is put. */
export function answersRiddle(text: string): boolean {
  return /\b(a |the )?river(s)?\b/i.test(text) && !/\bnot\b/i.test(text);
}

export class Vesna {
  constructor(private game: Game) {}

  async stage(playerId: number): Promise<Stage> {
    return ((await getFlag(playerId, 'vesna'))?.value ?? '') as Stage;
  }

  private async setStage(playerId: number, stage: Stage): Promise<void> {
    await setFlag(playerId, 'vesna', stage);
  }

  private async holding(s: Session, templateId: string): Promise<number | null> {
    const mine = await this.game.commerce.myItems(s);
    return mine.find((i) => i.template.id === templateId)?.id ?? null;
  }

  private voice(s: Session, line: string): void {
    s.out(c.speech(`Through the hatch: "${line}"`));
  }

  /** The gate into the ward stays barred until the quest is done. */
  async canPass(s: Session, room: Room, exit: Exit): Promise<string | null> {
    if (room.id !== GATE || exit.to !== WARD) return null;
    if ((await this.stage(s.player!.id)) === 'open') return null;
    return 'The gates are barred from the inside. Knock, if you have business.';
  }

  /** knock: the voice answers according to how far along you are. */
  async knock(s: Session): Promise<void> {
    const p = s.player!;
    s.out('You hammer on the gate. The sound goes away into the wood, and after a moment the hatch scrapes.');
    this.game.toRoom(p.roomId, c.dim(`${p.name} hammers on the gate of Vesna.`), s);
    const stage = await this.stage(p.id);
    if (stage === 'open') return this.voice(s, `Oh, it's you, ${p.name}. You know the way. Go on through.`);
    if (stage === 'riddle') return this.voice(s, 'Still waiting on that answer. ' + RIDDLE.replace(/^Through the hatch, slowly: /, ''));
    if (stage === '' ) {
      await this.setStage(p.id, 'asked');
      this.voice(s, "Gallowmere. We know about your plague cart. Nobody comes through without a letter from your priest saying they're clean, and a name the watch has nothing against. Get both, and then we'll talk.");
      return s.out(c.dim('Father Osmund keeps the Temple of Ash, in the town. ask osmund for a letter.'));
    }
    const heat = await this.game.law.heatOf(p.id);
    if (heat >= 1) return this.voice(s, "Your watch has your name in its book. Go and settle that first. We have our own trouble.");
    const letter = await this.holding(s, LETTER);
    if (!letter) return this.voice(s, "No letter, no talk. Your priest. Osmund, is it? Go and ask him.");
    if (stage === 'asked' || stage === 'letter') {
      await this.setStage(p.id, 'letter');
      this.voice(s, "A letter. Fine, fine. One more thing, since you're coming anyway. There's a man in your town called Hook. He has something for us. Bring it, and bring it shut.");
      return s.out(c.dim("Hook keeps a den behind a door the locals hint at. ask hook about vesna."));
    }
    // stage 'parcel': the letter and the parcel, still sealed.
    const parcel = await this.holding(s, PARCEL);
    if (!parcel) {
      const torn = await this.holding(s, TORN);
      return this.voice(s, torn ? 'That parcel has been opened. We can smell it from here. Go away.' : "Where's Hook's parcel? Sealed, mind.");
    }
    await tx(async (cl) => {
      await deleteItem(cl, parcel, { type: 'player', id: p.id });
      await deleteItem(cl, letter, { type: 'player', id: p.id });
    });
    await this.setStage(p.id, 'riddle');
    s.out(c.system('A hand comes out of the hatch, takes the letter and the parcel, and goes back in. Paper rustles. Wax cracks.'));
    s.out(c.speech(RIDDLE));
  }

  /** answer <words>: the riddle at the gate. One try an hour. */
  async answer(s: Session, rest: string): Promise<void> {
    const p = s.player!;
    if (p.roomId !== GATE) return s.out('Answer whom?');
    if ((await this.stage(p.id)) !== 'riddle') return this.voice(s, "Nobody asked you anything.");
    const last = await getFlag(p.id, 'vesna_try');
    if (last?.value && Date.now() - Number(last.value) < RIDDLE_RETRY_MS) return this.voice(s, 'One guess an hour. Think about it on the walk home.');
    if (!rest.trim()) return s.out('answer <words>');
    if (!answersRiddle(rest)) {
      await setFlag(p.id, 'vesna_try', String(Date.now()));
      return this.voice(s, 'No. Come back in an hour with a better one.');
    }
    await this.setStage(p.id, 'open');
    this.voice(s, 'The river. Of course it is. Stand back.');
    s.out(c.system('Bars scrape. The gate of Vesna opens a body\'s width, just for you. The way north is open.'));
    this.game.toRoom(p.roomId, c.dim(`The gate of Vesna opens a crack for ${p.name}.`), s);
    await this.game.town.rumour(p.id, `${p.name} was let in at the gate of Vesna`);
  }

  /** ask osmund for a letter. */
  async askLetter(s: Session): Promise<void> {
    const p = s.player!;
    const stage = await this.stage(p.id);
    if (stage === '') return s.out(c.speech('Father Osmund raises an eyebrow. "A letter? To whom, my child? Nobody writes to anybody in this town."'));
    if (stage === 'open' || stage === 'riddle') return s.out(c.speech('"I already vouched for you once. Once is generous."'));
    if (await this.holding(s, LETTER)) return s.out(c.speech('"You already have my letter. Don\'t lose it, I only have so much wax."'));
    const { rows } = await query("SELECT 1 FROM coin_ledger WHERE player_id = $1 AND reason LIKE 'burial of %' LIMIT 1", [p.id]);
    if (!rows.length) {
      return s.out(c.speech('Father Osmund shakes his head. "I don\'t put my seal on strangers. Do this house a service first. The streets are full of the dead, and nobody brings them to me."'));
    }
    if ((await this.game.law.heatOf(p.id)) >= 1) {
      return s.out(c.speech('"The watch has your name, my child. I can\'t swear to Vesna that you are clean when the whole town knows you aren\'t. Settle it first."'));
    }
    await createItem(null, LETTER, { type: 'player', id: p.id });
    await this.setStage(p.id, 'letter');
    s.out(c.speech('Father Osmund writes a few lines, slowly, then drips grey wax and presses his ring into it. "You brought me the dead when nobody else would. That\'s cleaner than most." He hands you a letter of passage.'));
  }

  /** ask hook about vesna: the parcel, once the voice has asked for it. */
  async askParcel(s: Session): Promise<void> {
    const p = s.player!;
    const stage = await this.stage(p.id);
    if (stage !== 'letter' && stage !== 'parcel') return s.out(c.speech('Hook looks at you for a long moment. "Vesna? Never heard of it." He has clearly heard of it.'));
    if (await this.holding(s, PARCEL)) return s.out(c.speech('"You have it. Why are you still here?"'));
    const torn = await getFlag(p.id, 'vesna_torn');
    if (torn?.value && Date.now() - Number(torn.value) < PARCEL_RETRY_MS) {
      return s.out(c.speech('"You opened the last one. Come back tomorrow, and this time keep your fingers to yourself."'));
    }
    await createItem(null, PARCEL, { type: 'player', id: p.id });
    await this.setStage(p.id, 'parcel');
    s.out(c.speech('Hook slides a small parcel across the table, wrapped in oilcloth and sealed with black wax. "For the gate. Don\'t open it. I\'ll know, and so will they."'));
  }

  /** open parcel: curiosity costs the step, and the watch hears of it. */
  async openParcel(s: Session): Promise<boolean> {
    const p = s.player!;
    const parcel = await this.holding(s, PARCEL);
    if (!parcel) return false;
    await tx(async (cl) => {
      await deleteItem(cl, parcel, { type: 'player', id: p.id });
    });
    await createItem(null, TORN, { type: 'player', id: p.id });
    await setFlag(p.id, 'vesna_torn', String(Date.now()));
    await this.setStage(p.id, 'letter');
    await query(
      "INSERT INTO crimes (player_id, kind, room_id, victim, witnesses, seen, heat) VALUES ($1, 'theft', $2, 'Hook', '[]', false, 15)",
      [p.id, p.roomId],
    );
    s.out(c.error('You crack the black wax. Inside: a folded map of Gallowmere\'s sewers, marked in a hand you don\'t know, and a dried rose. Somewhere, Hook knows. Word gets about; the watch hears you have been handling stolen goods.'));
    return true;
  }
}
