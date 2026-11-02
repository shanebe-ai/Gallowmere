// Weather and the hour (Milestone 5). Both are code: a game day runs four
// real hours, and the weather turns every 45 real minutes from a seeded roll
// weighted by a slow season cycle, so it survives restarts and two players
// always see the same sky. The AI is only told what it is like out.

import type { Room } from './world.js';

export type Phase = 'dawn' | 'day' | 'dusk' | 'night';
export type Sky = 'clear' | 'fog' | 'rain' | 'storm' | 'frost';
export const SKIES: Sky[] = ['clear', 'fog', 'rain', 'storm', 'frost'];

export const DAY_MS = 4 * 60 * 60_000;
export const SKY_MS = 45 * 60_000;
const SEASON_MS = 7 * 24 * 60 * 60_000;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
type Season = (typeof SEASONS)[number];

/** Weights per season for clear, fog, rain, storm, frost. */
const WEIGHTS: Record<Season, number[]> = {
  spring: [4, 3, 4, 1, 1],
  summer: [7, 1, 2, 2, 0],
  autumn: [3, 4, 4, 2, 1],
  winter: [2, 3, 2, 1, 5],
};

/** Rooms with no flag that are under the open sky all the same. */
const OPEN_AIR = new Set(['north_gate', 'barracks_yard', 'moor_road', 'wall_walk', 'rats_yard', 'bell_tower']);
/** The forest and the wilds: dark at night without a light, unless a fire burns there. */
export const WILD_DISTRICTS = new Set(['edgewood', 'blackwood', 'mere', 'falls', 'crags', 'stones']);

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function phaseAt(now: number): Phase {
  const f = (now % DAY_MS) / DAY_MS;
  return f < 0.12 ? 'dawn' : f < 0.6 ? 'day' : f < 0.72 ? 'dusk' : 'night';
}

/** The game clock hour, 0 to 23: dawn starts at 5am. */
export function hourAt(now: number): number {
  return Math.floor(((now % DAY_MS) / DAY_MS) * 24 + 5) % 24;
}

export function seasonAt(now: number): Season {
  return SEASONS[Math.floor(now / SEASON_MS) % 4];
}

export function skyAt(now: number): Sky {
  const slot = Math.floor(now / SKY_MS);
  const w = WEIGHTS[seasonAt(now)];
  let roll = hash(slot) * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SKIES.length; i++) if ((roll -= w[i]) < 0) return SKIES[i];
  return 'clear';
}

export function clockWords(hour: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}${hour < 12 ? 'am' : 'pm'}`;
}

const SKY_WORD: Record<Sky, string> = { clear: 'clear', fog: 'fog', rain: 'rain', storm: 'storm', frost: 'frost' };
const PHASE_WORD: Record<Phase, string> = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };

/** Lines for rooms under the sky, by weather and time of day. */
const OPEN: Record<Sky, Record<Phase, string[]>> = {
  clear: {
    dawn: ['The sky is going from grey to pale gold. Somewhere a cock crows, badly.', 'First light picks out every crack in the walls.'],
    day: ['A thin sun, as much as Gallowmere ever gets.', 'The sky is clear and high, and the town looks almost clean under it.'],
    dusk: ['The sun goes down red behind the smoke.', 'Long shadows, and the first lamps being lit.'],
    night: ['A cold clear night, full of stars the town does not deserve.', 'The moon is up, and every puddle has a copy of it.'],
  },
  fog: {
    dawn: ['Dawn fog, thick and white. Shapes come out of it late.', 'The fog has come up off the river in the night and not gone home.'],
    day: ['Fog hangs in the air all day, wet on your face.', 'You can see about a cart length. After that, the fog.'],
    dusk: ['The fog turns brown as the light goes.', 'Lamps make yellow balls in the fog and light nothing.'],
    night: ['Fog and dark together. You walk by memory.', 'The fog swallows sound. Footsteps come from everywhere.'],
  },
  rain: {
    dawn: ['Grey rain at first light, steady and patient.', 'It rained all night and has no plans to stop.'],
    day: ['Rain, straight down, filling every rut.', 'Water runs off the eaves in ropes.'],
    dusk: ['Rain and dusk, and the gutters talking to themselves.', 'The rain gets colder as the light goes.'],
    night: ['Rain in the dark, loud on every roof.', 'You can hear the rain better than you can see anything.'],
  },
  storm: {
    dawn: ['A storm at dawn: wind slamming shutters, rain going sideways.', 'Thunder rolls over the moor and the light comes up the colour of a bruise.'],
    day: ['A full storm. Lightning cracks somewhere over the mere.', 'Wind tears at your clothes. Something loose bangs and bangs.'],
    dusk: ['The storm is still going as the light goes. Sheets of rain.', 'Thunder, close. The whole street flinches.'],
    night: ['Black night and a storm in it. Every flash shows the street for a heartbeat.', 'The wind howls in the chimneys like the cart bell.'],
  },
  frost: {
    dawn: ['Frost on everything at dawn, white and sharp. Your breath smokes.', 'The ruts are frozen hard. The mud, for once, is quiet.'],
    day: ['A bitter clear cold. The frost never quite melts in the shade.', 'Icicles hang from the eaves and drip a little at noon.'],
    dusk: ['The cold comes down hard as the sun goes.', 'Frost is already forming again on the stones.'],
    night: ['A killing frost tonight. The stars look frozen too.', 'Everything that can creak with cold creaks.'],
  },
};

/** One extra touch per district, where it matters. */
const DISTRICT: Partial<Record<string, Partial<Record<Sky, string>>>> = {
  docks: { clear: 'Gulls quarrel over the fish market.', fog: 'Ship bells toll in the fog on the river.', rain: 'The river is pocked all over with rain.', storm: 'The boats grind against the quay in the swell.', frost: 'Ice crusts the edge of the river.' },
  market: { clear: 'Stalls are out, shouting.', fog: 'Stallholders call out to people they cannot see.', rain: 'Awnings sag with water; half the stalls are shut.', storm: 'Every stall is shut and lashed down.', frost: 'Traders stamp their feet and blow on their hands.' },
  moor: { clear: 'The heather runs away to the sky.', fog: 'The moor is gone in the fog. Only the road is left.', rain: 'Rain sweeps across the heather in grey curtains.', storm: 'There is nowhere on the moor to hide from this.', frost: 'The heather is white with rime.' },
  edgewood: { fog: 'The trees fade to ghosts a few steps in.', rain: 'Rain patters through the leaves long after it should.', storm: 'Branches thrash and something cracks deep in the wood.' },
  blackwood: { fog: 'The Blackwood is blacker in the fog.', storm: 'The old trees groan like ships.' },
  mere: { clear: 'The mere is flat as a coin.', fog: 'Fog lies on the mere so thick the island is gone.', rain: 'The mere is a grey drum under the rain.', storm: 'Whitecaps on the mere. No boat would go out in this.', frost: 'A rim of ice edges the mere.' },
  falls: { rain: 'The falls are loud and brown with rain.', storm: 'The falls roar like a crowd.' },
  vesna: { clear: 'Every lantern burns, day or night.', fog: 'The lanterns glow through the fog like a path.', rain: 'Rain hisses on the lanterns and none go out.' },
};

/** Muffled versions for rooms with a roof. */
const INDOORS: Record<Sky, string> = {
  clear: '',
  fog: 'Fog presses grey against the windows.',
  rain: 'Rain drums on the roof and runs down the panes.',
  storm: 'The storm shakes the shutters. The fire leans in the draught.',
  frost: 'Frost ferns cover the windows. Everyone keeps near the fire.',
};

export interface WeatherNow { phase: Phase; sky: Sky; hour: number; season: Season }

export class Weather {
  private forced: { sky?: Sky; phase?: Phase; until: number } | null = null;

  constructor(private clock: () => number = Date.now) {
    // Tests run with a fixed sky so the forest is never dark by surprise.
    const fixed = process.env.GALLOWMERE_FIXED_WEATHER;
    if (fixed) {
      const [phase, sky] = fixed.split(',') as [Phase, Sky];
      this.forced = { phase, sky, until: Number.MAX_SAFE_INTEGER };
    }
  }

  now(): WeatherNow {
    const t = this.clock();
    const f = this.forced && this.forced.until > t ? this.forced : null;
    const phase = f?.phase ?? phaseAt(t);
    const hour = f?.phase ? { dawn: 6, day: 12, dusk: 19, night: 23 }[f.phase] : hourAt(t);
    return { phase, sky: f?.sky ?? skyAt(t), hour, season: seasonAt(t) };
  }

  /** Admins and tests set the sky (and optionally the hour) for a while. */
  force(sky: Sky | null, phase?: Phase, ms = 60 * 60_000): void {
    if (!sky && !phase) { this.forced = null; return; }
    this.forced = { sky: sky ?? undefined, phase, until: this.clock() + ms };
  }

  isNight(): boolean {
    return this.now().phase === 'night';
  }

  /** "Dusk, rain" for the status bar. */
  label(): string {
    const w = this.now();
    return `${PHASE_WORD[w.phase]}, ${SKY_WORD[w.sky]}`;
  }

  /** Is this room under the sky? */
  static openAir(room: Room): boolean {
    return room.flags.includes('outside') || room.flags.includes('street') || OPEN_AIR.has(room.id);
  }

  /** The line a room shows for the weather, or '' for none (sewers, caves). */
  line(room: Room): string {
    const w = this.now();
    if (room.flags.includes('sewer') || room.flags.includes('dark')) return '';
    if (!Weather.openAir(room)) return INDOORS[w.sky];
    const lines = OPEN[w.sky][w.phase];
    const pick = lines[Math.floor(this.clock() / SKY_MS) % lines.length];
    const extra = DISTRICT[room.district]?.[w.sky];
    return extra ? `${pick} ${extra}` : pick;
  }

  /** What an NPC is told about it. */
  note(): string {
    const w = this.now();
    return `It is ${clockWords(w.hour)} (${w.phase}), ${w.season}, and the weather is ${w.sky}.`;
  }

  /** Fishing: rain brings them up, storms and frost drive them deep. */
  fishingFactor(): number {
    return { clear: 1, fog: 1.1, rain: 1.3, storm: 0.6, frost: 0.7 }[this.now().sky];
  }
}
