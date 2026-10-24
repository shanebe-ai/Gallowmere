// Street folk and beasts: generated people and animals that can be fought.
// Everything about a fight is code; these cards only give them a voice on the light AI tier.

export type MobKind =
  | 'drunk'
  | 'dog'
  | 'ragpicker'
  | 'preacher'
  | 'cutpurse'
  | 'ratcatcher'
  | 'bruiser'
  | 'rat'
  | 'big_rat'
  | 'giant_rat'
  | 'cart_rat'
  | 'rat_king';

export interface MobSpec {
  kind: MobKind;
  noun: string; // "drunk": used in names and keywords
  level: number;
  health: [number, number];
  damage: [number, number];
  armour: number;
  coin: [number, number];
  /** Items they might carry: [template id, chance]. */
  carries: Array<[string, number]>;
  /** Flees once health falls to this share of the most it can have. 0 = never flees. */
  flee: number;
  /** Words for a landed hit: "Wat punches you." */
  hits: string;
  /** How they move, for "Wat staggers off east." */
  moves: string;
  street: boolean;
  mute?: boolean;
  /** Animals and beasts have no personal name. */
  named: boolean;
  corpse: 'street' | 'rat';
  card: {
    job: string;
    personality: string;
    speech: string;
    wants: string;
    knows: string;
    look: string[];
    scripted: string[];
    ambient: string[];
  };
}

export const MOBS: Record<MobKind, MobSpec> = {
  drunk: {
    kind: 'drunk', noun: 'drunk', level: 1, health: [10, 14], damage: [1, 2], armour: 0, coin: [0, 4],
    carries: [['empty_bottle', 0.7]], flee: 0.3, hits: 'punches', moves: 'staggers', street: true, named: true, corpse: 'street',
    card: {
      job: 'a drunk who sleeps wherever they fall in the streets of Gallowmere',
      personality: 'maudlin, quarrelsome, sentimental, quick to take offence and quicker to forget it',
      speech: 'slurred, rambling, overly familiar, calls everyone friend or sweetheart, loses the thread',
      wants: 'another drink, someone to blame, a dry doorway',
      knows: 'which taverns give credit (none), that Morda waters nothing but her temper, that the cart came close last night',
      look: ['Red eyed and unsteady, with a coat that has been slept in for a week.', 'Swaying gently, as if the street were a boat, and smelling of gin and the gutter.'],
      scripted: ['"Friend! You look like a friend. Lend us a copper?"', 'The drunk hiccups and loses the thread entirely.', '"I know you. Don\'t I? No."'],
      ambient: ['The drunk sings two lines of a song and stops, sad about it.', 'The drunk sways, grabs at nothing for balance, and somehow stays up.'],
    },
  },
  dog: {
    kind: 'dog', noun: 'dog', level: 1, health: [8, 10], damage: [1, 3], armour: 0, coin: [0, 0],
    carries: [['bone', 0.5]], flee: 0.4, hits: 'bites', moves: 'trots', street: true, mute: true, named: false, corpse: 'street',
    card: {
      job: 'a mangy stray dog that lives off the streets of Gallowmere',
      personality: 'wary, hungry, cunning, quick to bite and quicker to run',
      speech: 'none',
      wants: 'scraps, a warm corner, to not be kicked',
      knows: 'every gutter and midden in town',
      look: ['A rangy stray, ribs showing, one ear torn. It watches your hands, not your face.'],
      scripted: ['The dog growls low in its throat.', 'The dog sniffs at you and backs away.'],
      ambient: ['The stray dog noses through a heap of rubbish.', 'The stray dog scratches at a flea with great concentration.'],
    },
  },
  ragpicker: {
    kind: 'ragpicker', noun: 'rag picker', level: 1, health: [9, 12], damage: [1, 2], armour: 0, coin: [0, 2],
    carries: [['rags', 0.9], ['bent_nail', 0.4]], flee: 0.7, hits: 'scratches', moves: 'shuffles', street: true, named: true, corpse: 'street',
    card: {
      job: 'a rag picker who searches the gutters of Gallowmere for anything that can be sold',
      personality: 'timid, watchful, mournful, sharp eyed for anything dropped',
      speech: 'quiet and hurried, eyes down, apologises a lot, speaks of finds like treasures',
      wants: 'to be left alone, and whatever you were about to drop',
      knows: 'what turns up in the gutters, what the cart leaves behind, that Tilly pays least and Hook asks least',
      look: ['Bent double under a sack of rags, fingers black from the gutters.', 'A small, grey figure who never quite looks at you.'],
      scripted: ['"Nothing here, nothing, just rags."', 'The rag picker hugs the sack closer.'],
      ambient: ['The rag picker fishes something out of the gutter, studies it, and pockets it.', 'The rag picker sorts rags by some system only they understand.'],
    },
  },
  preacher: {
    kind: 'preacher', noun: 'preacher', level: 2, health: [14, 18], damage: [1, 3], armour: 0, coin: [0, 3],
    carries: [['tract', 1], ['candle', 0.5]], flee: 0.4, hits: 'strikes', moves: 'strides', street: true, named: true, corpse: 'street',
    card: {
      job: 'a mad street preacher who warns Gallowmere that the cart comes for the wicked',
      personality: 'fervent, wild eyed, theatrical, unshakeably certain, oddly kind to the poor',
      speech: 'booming, biblical, full of doom, the cart and the wicked, turns everything into a sermon',
      wants: 'repentance, an audience, for Father Osmund to admit he stopped believing',
      knows: 'that the cart comes at the bell, that Osmund lost his faith, that something knocks behind the iron door in the sewers',
      look: ['Gaunt and burning eyed, in a sackcloth robe, a bundle of soggy tracts under one arm.'],
      scripted: ['"The cart comes for the wicked! Are you wicked? It comes for everyone else too!"', '"Repent, and keep your coin in the counting house!"'],
      ambient: ['The preacher raises both arms and announces the end of all things to a passing dog.', 'The preacher presses a soggy tract on someone who drops it at once.'],
    },
  },
  cutpurse: {
    kind: 'cutpurse', noun: 'cutpurse', level: 2, health: [13, 17], damage: [1, 4], armour: 0, coin: [3, 9],
    carries: [['knife', 0.8]], flee: 0.5, hits: 'slashes', moves: 'slips', street: true, named: true, corpse: 'street',
    card: {
      job: 'a cutpurse working the crowds of Gallowmere, with a price on their head from the watch',
      personality: 'charming, quick, mocking, cowardly when it counts, always measuring your purse',
      speech: 'easy and friendly, a little too friendly, compliments you, asks what you are carrying',
      wants: 'your purse, a crowd to vanish into, to never meet the watch',
      knows: 'which merchants are careless, that the watch pays for cutpurses, that Hook buys anything',
      look: ['Neat, quick and forgettable, with clever hands that never stay still.', 'A friendly face and eyes that keep sliding to your belt.'],
      scripted: ['"Lovely day for it. Whatever it is you\'re doing."', 'The cutpurse smiles and drifts a little closer.'],
      ambient: ['The cutpurse brushes past someone and comes away with nothing. This time.', 'The cutpurse leans on a post, watching purses go by.'],
    },
  },
  ratcatcher: {
    kind: 'ratcatcher', noun: 'rat catcher', level: 2, health: [15, 19], damage: [2, 4], armour: 0, coin: [1, 5],
    carries: [['rat_tail', 0.9], ['rat_tail', 0.6], ['rat_tail', 0.3], ['iron_key', 0.15]], flee: 0.3, hits: 'clubs', moves: 'trudges', street: true, named: true, corpse: 'street',
    card: {
      job: 'a rat catcher who works the drains and sewers of Gallowmere and sells the tails to Maud',
      personality: 'blunt, grim humoured, fearless about filth, superstitious about the deep sewers',
      speech: 'plain and earthy, full of rat lore, spits at any mention of the iron door',
      wants: 'tails, coin for tails, never to go past the iron door again',
      knows: 'that Maud pays a copper a tail, that the rats get bigger past the grate, that something called the rat king lives beyond the iron door, that Hook sells a key to it',
      look: ['Leather apron, a club on the belt and a string of rat tails over one shoulder.'],
      scripted: ['"Tails is a copper each at Maud\'s. Don\'t let her tell you otherwise."', '"Don\'t go past the iron door. I mean it."'],
      ambient: ['The rat catcher counts the tails twice and spits.', 'The rat catcher peers down a drain and nods, satisfied.'],
    },
  },
  bruiser: {
    kind: 'bruiser', noun: 'bruiser', level: 3, health: [22, 28], damage: [2, 5], armour: 1, coin: [4, 12],
    carries: [['cudgel', 0.6]], flee: 0.15, hits: 'hammers', moves: 'shoulders', street: true, named: true, corpse: 'street',
    card: {
      job: 'a dock bruiser who unloads barges when sober and breaks heads when not',
      personality: 'proud, touchy, loud, loyal to the docks, enjoys a fight a little too much',
      speech: 'short, loud, threatening, river slang, takes everything as a challenge',
      wants: 'respect, a fight worth having, the wages the harbourmaster owes',
      knows: 'the docks, the barges, who smuggles what, that Hook buys from the cart men',
      look: ['Shoulders like a door, knuckles like walnuts, a nose broken more than once.'],
      scripted: ['"You looking at something?"', 'The bruiser cracks each knuckle, slowly, one at a time.'],
      ambient: ['The bruiser spits in the gutter and dares anyone to say something.', 'The bruiser rolls both shoulders, warming up for something.'],
    },
  },
  rat: {
    kind: 'rat', noun: 'rat', level: 1, health: [5, 7], damage: [1, 2], armour: 0, coin: [0, 0],
    carries: [['rat_tail', 1]], flee: 0, hits: 'bites', moves: 'scurries', street: false, mute: true, named: false, corpse: 'rat',
    card: {
      job: 'a fat sewer rat', personality: 'bold, hungry, unafraid of people', speech: 'none', wants: 'food, anything you drop',
      knows: 'the sewers',
      look: ['A fat brown rat, bold as brass, watching you with black bead eyes.'],
      scripted: ['The rat squeaks and holds its ground.', 'The rat stands on its hind legs and stares at you.'],
      ambient: ['A rat drags something into the dark.', 'Rats squabble over a scrap.'],
    },
  },
  big_rat: {
    kind: 'big_rat', noun: 'big rat', level: 2, health: [10, 12], damage: [1, 3], armour: 0, coin: [0, 0],
    carries: [['rat_tail', 1]], flee: 0, hits: 'bites', moves: 'scurries', street: false, mute: true, named: false, corpse: 'rat',
    card: {
      job: 'a big sewer rat, the size of a cat', personality: 'vicious, territorial', speech: 'none', wants: 'to drive you off',
      knows: 'the tunnels',
      look: ['A rat the size of a cat, scarred and grey, with yellow teeth that have chewed through worse than you.'],
      scripted: ['The big rat hisses.', 'The big rat lashes its tail.'],
      ambient: ['Something big moves in the water.', 'Claws scrape on brick, close by.'],
    },
  },
  giant_rat: {
    kind: 'giant_rat', noun: 'giant rat', level: 3, health: [16, 20], damage: [2, 4], armour: 0, coin: [0, 0],
    carries: [['rat_tail', 1]], flee: 0, hits: 'tears into', moves: 'slinks', street: false, mute: true, named: false, corpse: 'rat',
    card: {
      job: 'a giant rat the size of a dog, from beyond the iron door', personality: 'cunning, patient, savage', speech: 'none', wants: 'meat',
      knows: 'the cistern and what swims in it',
      look: ['A rat the size of a dog, slick and black from the cistern, with a long bald tail and too much intelligence in its eyes.'],
      scripted: ['The giant rat circles you slowly.', 'The giant rat chatters its teeth.'],
      ambient: ['A giant rat slides into the black water without a ripple.', 'Eyes shine at the edge of the light, low to the ground.'],
    },
  },
  cart_rat: {
    kind: 'cart_rat', noun: 'bloated rat', level: 4, health: [22, 26], damage: [2, 5], armour: 0, coin: [0, 0],
    carries: [['rat_tail', 1], ['old_coin', 0.3], ['tin_ring', 0.3]], flee: 0, hits: 'savages', moves: 'drags itself', street: false, mute: true, named: false, corpse: 'rat',
    card: {
      job: 'a bloated rat grown huge on what the cart men tip on the bone shelf', personality: 'slow, greedy, horribly strong', speech: 'none', wants: 'the heap, all of it',
      knows: 'the bone shelf',
      look: ['Bloated, pale and nearly hairless, the size of a pig, things glinting in the folds of its skin where it has rolled in the heap.'],
      scripted: ['The bloated rat heaves itself toward you.', 'The bloated rat wheezes.'],
      ambient: ['Something in the heap shifts and settles.', 'A wet, heavy dragging sound comes from the bone shelf.'],
    },
  },
  rat_king: {
    kind: 'rat_king', noun: 'rat king', level: 6, health: [48, 48], damage: [3, 7], armour: 1, coin: [0, 0],
    carries: [['rat_king_knot', 1], ['rat_tail', 1], ['rat_tail', 1], ['rat_tail', 1]], flee: 0, hits: 'swarms over', moves: 'boils', street: false, mute: true, named: false, corpse: 'rat',
    card: {
      job: 'the rat king: a dozen rats with their tails grown into one knot, moving as one thing',
      personality: 'ancient, hateful, many minded, it remembers', speech: 'none', wants: 'the town, eventually',
      knows: 'everything that ever went down the drains',
      look: ['A dozen rats, maybe more, their tails knotted together into one hard mass, moving as one creature. Every head turns to look at you at once.'],
      scripted: ['The rat king screams with a dozen mouths.', 'The rat king seethes, every head watching you.'],
      ambient: ['The rat king shifts in the straw, a dozen heads turning.', 'A chorus of squeaks rises and falls, almost like words.'],
    },
  },
};

/**
 * Street folk the streets are filled from: [kind, weight, most at once]. The cap matters: kinds that
 * never brawl (preachers, rag pickers) would otherwise outlive everyone and take over the streets.
 */
export const STREET_MIX: Array<[MobKind, number, number]> = [
  ['drunk', 3, 3],
  ['dog', 2, 2],
  ['ragpicker', 2, 1],
  ['preacher', 1, 1],
  ['cutpurse', 2, 2],
  ['ratcatcher', 1, 1],
  ['bruiser', 2, 2],
];

/** Beasts kept in the sewers: how many of each, and where. */
export const SEWER_POP: Array<{ kind: MobKind; room: string; count: number }> = [
  { kind: 'rat', room: 'sewer_grate', count: 3 },
  { kind: 'big_rat', room: 'grate_tunnel', count: 2 },
  { kind: 'big_rat', room: 'overflow', count: 2 },
  { kind: 'giant_rat', room: 'old_cistern', count: 2 },
  { kind: 'cart_rat', room: 'bone_shelf', count: 1 },
  { kind: 'rat_king', room: 'the_nest', count: 1 },
];

const FIRST = [
  'Wat', 'Hob', 'Dickon', 'Jankin', 'Hodge', 'Simkin', 'Piers', 'Gib', 'Hal', 'Ralf', 'Colin', 'Tom', 'Will', 'Robin', 'Osbert', 'Ned',
  'Agnes', 'Joan', 'Margery', 'Cecily', 'Edith', 'Avice', 'Mabel', 'Sibyl', 'Rose', 'Beatrix', 'Alys', 'Emma', 'Nell', 'Isot',
];

const EPITHET = [
  'Crookhand', 'Ditchwater', 'Halfpenny', 'Redbeard', 'One Ear', 'Stoneface', 'Ratbag', 'Twitch', 'Longshanks', 'Mudlark',
  'Pale', 'Greasy', 'Sallow', 'Lackpenny', 'Hookhand', 'Wetfoot', 'Gristle', 'Hollowcheek', 'Saltbones', 'Thimble',
];

const QUIRKS = [
  'hums the same three notes over and over',
  'swears they once shook the hand of the old king',
  'is convinced the river is getting closer every year',
  'keeps a lucky tooth on a string and touches it when nervous',
  'laughs at the wrong moments',
  'has a grudge against the harbourmaster and brings it up constantly',
  'counts things under their breath: steps, coins, people',
  'claims to have seen the face of the plague cart driver',
  'is saving up for a pair of boots and tells everyone',
  'believes rats can understand people and talks to them',
  'is certain Father Osmund owes them money',
  'remembers every insult anyone ever paid them',
  'tells everyone about a brother on the barges who is coming back rich any day now',
  'cannot stand the sound of the temple bell',
];

const pick = <T>(xs: T[], r: () => number): T => xs[Math.floor(r() * xs.length)];
const between = ([lo, hi]: [number, number], r: () => number) => lo + Math.floor(r() * (hi - lo + 1));

export interface Generated {
  name: string; // short name used in speech: "Wat"
  listName: string; // "Wat Ditchwater, a drunk"
  keywords: string[];
  health: number;
  coin: number;
  items: string[];
  quirk: string | null;
  look: string;
}

/** Rolls a person or beast of the given kind. */
export function generate(kind: MobKind, r: () => number): Generated {
  const spec = MOBS[kind];
  const items = spec.carries.filter(([, chance]) => r() < chance).map(([id]) => id);
  const health = between(spec.health, r);
  const coin = between(spec.coin, r);
  const look = pick(spec.card.look, r);
  if (!spec.named) {
    const a = /^[aeiou]/.test(spec.noun) ? 'an' : 'a';
    const listName = kind === 'rat_king' ? 'the rat king' : kind === 'dog' ? 'a stray dog' : `${a} ${spec.noun}`;
    const keywords = [...new Set([...spec.noun.split(' '), spec.noun, 'rat', kind === 'dog' ? 'stray' : '', kind === 'dog' ? 'mutt' : ''])].filter(
      (k) => k && (kind === 'dog' ? k !== 'rat' : true),
    );
    return { name: listName.replace(/^(a|an|the) /, ''), listName, keywords, health, coin, items, quirk: null, look };
  }
  const first = pick(FIRST, r);
  const epithet = pick(EPITHET, r);
  const a = /^[aeiou]/.test(spec.noun) ? 'an' : 'a';
  const keywords = [first.toLowerCase(), ...epithet.toLowerCase().split(' '), spec.noun, ...spec.noun.split(' ')];
  return {
    name: first,
    listName: `${first} ${epithet}, ${a} ${spec.noun}`,
    keywords: [...new Set(keywords)],
    health,
    coin,
    items,
    quirk: pick(QUIRKS, r),
    look,
  };
}

export function randBetween(range: [number, number], r: () => number): number {
  return between(range, r);
}
