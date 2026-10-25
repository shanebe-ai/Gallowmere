// Ready made emotes: wave, laugh, bow and friends, alone or at someone.
// Each one is [you do it, others see it] plus how it points at someone, if it can.

export interface Social {
  you: string; // "wave"
  they: string; // "waves"
  /** How it points at someone: "at" gives "wave at Morda", "" gives "hug Morda". Missing: can't point. */
  to?: string;
  /** Extra words after the verb when done alone: "laugh out loud". */
  alone?: string;
  /** Extra words after the target: "nod to Morda in greeting". */
  after?: string;
}

export const SOCIALS: Record<string, Social> = {
  wave: { you: 'wave', they: 'waves', to: 'at' },
  laugh: { you: 'laugh', they: 'laughs', to: 'at', alone: 'out loud' },
  chuckle: { you: 'chuckle', they: 'chuckles', to: 'at' },
  giggle: { you: 'giggle', they: 'giggles', to: 'at' },
  cackle: { you: 'cackle', they: 'cackles', to: 'at', alone: 'wickedly' },
  snicker: { you: 'snicker', they: 'snickers', to: 'at' },
  smile: { you: 'smile', they: 'smiles', to: 'at' },
  grin: { you: 'grin', they: 'grins', to: 'at', alone: 'from ear to ear' },
  smirk: { you: 'smirk', they: 'smirks', to: 'at' },
  frown: { you: 'frown', they: 'frowns', to: 'at' },
  scowl: { you: 'scowl', they: 'scowls', to: 'at' },
  glare: { you: 'glare', they: 'glares', to: 'at', alone: 'at nothing in particular' },
  wink: { you: 'wink', they: 'winks', to: 'at' },
  blush: { you: 'blush', they: 'blushes', alone: 'to the roots of your hair' },
  nod: { you: 'nod', they: 'nods', to: 'to' },
  shrug: { you: 'shrug', they: 'shrugs', to: 'at' },
  sigh: { you: 'sigh', they: 'sighs', alone: 'heavily' },
  groan: { you: 'groan', they: 'groans' },
  yawn: { you: 'yawn', they: 'yawns', alone: 'hugely' },
  stretch: { you: 'stretch', they: 'stretches', alone: 'until something cracks' },
  shiver: { you: 'shiver', they: 'shivers', alone: 'in the damp' },
  cough: { you: 'cough', they: 'coughs' },
  sneeze: { you: 'sneeze', they: 'sneezes', alone: 'violently' },
  gasp: { you: 'gasp', they: 'gasps', to: 'at' },
  cry: { you: 'burst into tears', they: 'bursts into tears' },
  sob: { you: 'sob', they: 'sobs', alone: 'quietly' },
  sulk: { you: 'sulk', they: 'sulks', alone: 'in a corner' },
  pout: { you: 'pout', they: 'pouts', to: 'at' },
  bow: { you: 'bow', they: 'bows', to: 'to' },
  curtsey: { you: 'curtsey', they: 'curtseys', to: 'to' },
  kneel: { you: 'kneel', they: 'kneels', to: 'before' },
  salute: { you: 'salute', they: 'salutes', to: '' },
  clap: { you: 'clap', they: 'claps', to: 'for' },
  applaud: { you: 'applaud', they: 'applauds', to: '' },
  cheer: { you: 'cheer', they: 'cheers', to: 'for' },
  dance: { you: 'dance', they: 'dances', to: 'with', alone: 'a little jig' },
  hug: { you: 'hug', they: 'hugs', to: '' },
  comfort: { you: 'comfort', they: 'comforts', to: '' },
  highfive: { you: 'high five', they: 'high fives', to: '' },
  point: { you: 'point', they: 'points', to: 'at' },
  beg: { you: 'beg', they: 'begs', to: '', alone: 'like a dog' },
  grovel: { you: 'grovel', they: 'grovels', to: 'before' },
  flex: { you: 'flex', they: 'flexes', to: 'at', alone: 'your muscles' },
  facepalm: { you: 'put your face in your hand', they: 'puts their face in their hand' },
  ponder: { you: 'ponder', they: 'ponders', alone: 'the meaning of it all' },
  think: { you: 'think', they: 'thinks', alone: 'hard' },
  whistle: { you: 'whistle', they: 'whistles', to: 'at', alone: 'a little tune' },
  hum: { you: 'hum', they: 'hums', alone: 'to yourself' },
  sing: { you: 'sing', they: 'sings', to: 'to', alone: 'a bawdy song, badly' },
  growl: { you: 'growl', they: 'growls', to: 'at' },
  spit: { you: 'spit', they: 'spits', to: 'at', alone: 'in the gutter' },
  tip: { you: 'tip your hat', they: 'tips their hat', to: 'to' },
  roll: { you: 'roll your eyes', they: 'rolls their eyes', to: 'at' },
  eyeroll: { you: 'roll your eyes', they: 'rolls their eyes', to: 'at' },
  scratch: { you: 'scratch your head', they: 'scratches their head' },
  thumbsup: { you: 'give a thumbs up', they: 'gives a thumbs up', to: 'to' },
  pray: { you: 'pray', they: 'prays', to: 'for', alone: 'quietly' },
};

/** "high five" reads as "high five Morda" and "high fives you". */
function phrase(verb: string, to: string | undefined, target: string): string {
  return to ? `${verb} ${to} ${target}` : `${verb} ${target}`;
}

/** The three lines of a social: what you see, what the target sees, what the room sees. */
export function socialLines(s: Social, me: string, target?: string): { mine: string; theirs?: string; room: string } {
  const own = (t: string) => t.replace(/\byourself\b/, 'themselves').replace(/\byour\b/g, 'their');
  if (!target) {
    const extra = s.alone ? ` ${s.alone}` : '';
    return { mine: `You ${s.you}${extra}.`, room: `${me} ${s.they}${own(extra)}.` };
  }
  return {
    mine: `You ${phrase(s.you, s.to, target)}.`,
    theirs: `${me} ${phrase(s.they, s.to, 'you')}.`,
    room: `${me} ${phrase(s.they, s.to, target)}.`,
  };
}

/** Pointed at a character, for their reaction: "waves at you". */
export function socialEvent(s: Social): string {
  return phrase(s.they, s.to, 'you');
}
