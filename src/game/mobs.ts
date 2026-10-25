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
  | 'rat_king'
  | 'fox'
  | 'deer'
  | 'goat'
  | 'wolf'
  | 'boar'
  | 'heron'
  | 'otter'
  | 'brigand'
  | 'cutthroat'
  | 'bear'
  | 'captain'
  | 'wight';

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
  /** What is left when they die: 'none' for things that crumble to dust. */
  corpse: 'street' | 'rat' | 'beast' | 'none';
  /** Attacks players who come into its room. */
  aggressive?: boolean;
  /** Joins in when one of its own kind in the room is attacked. */
  pack?: boolean;
  /** The watch pays this much a head. */
  bounty?: number;
  /** How long until one comes back where it lives, after it dies. */
  respawnMs?: number;
  /** "the brigand captain": a fixed name instead of "a wolf". */
  fixedName?: string;
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
  fox: {
    kind: 'fox', noun: 'fox', level: 1, health: [8, 10], damage: [1, 2], armour: 0, coin: [0, 0],
    carries: [['fox_pelt', 1]], flee: 0.6, hits: 'bites', moves: 'slinks', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'a red fox of the Edgewood', personality: 'wary, clever, quick to run', speech: 'none', wants: 'rabbits, scraps, to not be seen',
      knows: 'every run and earth in the wood',
      look: ['A red fox, lean and bright eyed, with a white tipped brush. It watches you sideways, ready to vanish.'],
      scripted: ['The fox yips and backs away.', 'The fox flattens its ears.'],
      ambient: ['A fox trots across the clearing with something in its mouth.', 'The fox sits and scratches behind one ear.'],
    },
  },
  deer: {
    kind: 'deer', noun: 'deer', level: 1, health: [10, 12], damage: [1, 2], armour: 0, coin: [0, 0],
    carries: [['venison', 1], ['deer_hide', 1]], flee: 0.95, hits: 'kicks', moves: 'bounds', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'a red deer hind', personality: 'skittish, alert, gone at the first wrong sound', speech: 'none', wants: 'grass, quiet',
      knows: 'the deer paths',
      look: ['A red deer hind, ears turning like weathervanes, every muscle ready to run.'],
      scripted: ['The deer stamps a hoof.', 'The deer freezes, staring at you.'],
      ambient: ['The deer lifts its head, listens, and goes back to grazing.', 'The deer flicks its ears at a fly.'],
    },
  },
  goat: {
    kind: 'goat', noun: 'mountain goat', level: 2, health: [12, 15], damage: [1, 3], armour: 0, coin: [0, 0],
    carries: [['goat_meat', 1]], flee: 0.3, hits: 'butts', moves: 'clatters', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'a shaggy mountain goat of the crags', personality: 'stubborn, bold, sure footed, rude', speech: 'none', wants: 'the path to itself',
      knows: 'every ledge on the crags',
      look: ['A shaggy grey goat with curling horns and yellow eyes with square pupils, looking at you as if you were in its way. You are.'],
      scripted: ['The goat lowers its horns.', 'The goat bleats rudely.'],
      ambient: ['The goat chews something it shouldn\'t.', 'Stones clatter down where the goat jumped.'],
    },
  },
  wolf: {
    kind: 'wolf', noun: 'grey wolf', level: 3, health: [18, 22], damage: [2, 4], armour: 0, coin: [0, 0],
    carries: [['wolf_pelt', 1]], flee: 0.2, hits: 'bites', moves: 'lopes', street: false, mute: true, named: false, corpse: 'beast', pack: true,
    card: {
      job: 'a grey wolf of the Blackwood', personality: 'patient, wary, deadly in a pack', speech: 'none', wants: 'meat, the pack, the dark',
      knows: 'the Blackwood',
      look: ['A grey wolf, lean and long legged, its yellow eyes fixed on you without blinking.'],
      scripted: ['The wolf growls, low.', 'The wolf\'s hackles rise.'],
      ambient: ['A wolf lifts its nose to the wind.', 'Somewhere close, a wolf howls, and another answers.'],
    },
  },
  boar: {
    kind: 'boar', noun: 'wild boar', level: 4, health: [24, 28], damage: [2, 5], armour: 1, coin: [0, 0],
    carries: [['boar_meat', 1], ['tusk', 0.7]], flee: 0.1, hits: 'gores', moves: 'crashes', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'a wild boar of the Blackwood', personality: 'bad tempered, fearless, charges first', speech: 'none', wants: 'mud, roots, you gone',
      knows: 'the wallow',
      look: ['A wild boar, black bristled and humped, with yellow tusks curling from its jaw and small red eyes full of grudge.'],
      scripted: ['The boar paws the ground.', 'The boar grunts and lowers its head.'],
      ambient: ['The boar roots in the mud, grunting.', 'The boar rubs its flank against a tree, hard.'],
    },
  },
  heron: {
    kind: 'heron', noun: 'grey heron', level: 1, health: [6, 8], damage: [1, 2], armour: 0, coin: [0, 0],
    carries: [], flee: 0.9, hits: 'stabs', moves: 'flaps', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'a grey heron fishing the reeds', personality: 'patient, solemn, a thief', speech: 'none', wants: 'fish, especially yours',
      knows: 'the shallows',
      look: ['A tall grey heron standing on one leg in the shallows, still as a post, its dagger beak ready.'],
      scripted: ['The heron gives you a long, unfriendly look.', 'The heron croaks.'],
      ambient: ['The heron stabs the water and comes up with a fish.', 'The heron stands on one leg, perfectly still.'],
    },
  },
  otter: {
    kind: 'otter', noun: 'otter', level: 1, health: [8, 10], damage: [1, 2], armour: 0, coin: [0, 0],
    carries: [], flee: 0.8, hits: 'bites', moves: 'slides', street: false, mute: true, named: false, corpse: 'beast',
    card: {
      job: 'an otter of the plunge pool', personality: 'playful, curious, bold', speech: 'none', wants: 'trout, play',
      knows: 'the pool',
      look: ['A sleek brown otter, whiskers dripping, watching you from the water with frank curiosity.'],
      scripted: ['The otter chirps at you.', 'The otter rolls over in the water.'],
      ambient: ['The otter slides into the pool without a splash.', 'The otter eats a trout on a rock, crunching.'],
    },
  },
  brigand: {
    kind: 'brigand', noun: 'brigand', level: 4, health: [26, 32], damage: [2, 5], armour: 1, coin: [3, 10],
    carries: [['knife', 0.4], ['cudgel', 0.3], ['hand_axe', 0.2], ['padded_jerkin', 0.2]], flee: 0.2, hits: 'hacks at', moves: 'slips', street: false, named: true, corpse: 'street',
    aggressive: true, pack: true, bounty: 5, respawnMs: 10 * 60_000,
    card: {
      job: 'a brigand of the north road, red band on one arm, who robs travellers at Brigand\'s Bend',
      personality: 'swaggering, greedy, cruel when it pays, loyal to the captain, superstitious about the toll stump',
      speech: 'rough, mocking, road slang, calls travellers pilgrim or pigeon, loves a threat',
      wants: 'your purse, a share, a warm fire, to see Vesna\'s gate open',
      knows: 'the road, the bend, the camp in the Blackwood, that Hook buys their takings, that the captain carries a blade like water, that nobody stops at the toll stump after dark',
      look: ['Mud to the knees, a red band on one arm, a blade in the belt and a grin with gaps in it.', 'Lean and weathered, in a stolen cloak too good for them, with a red rag tied round one arm.'],
      scripted: ['"Toll, pigeon. Everyone pays the toll."', '"Look what the road brought us."', 'The brigand spits and grins.'],
      ambient: ['The brigand cleans their nails with a knife.', 'The brigand laughs at something another brigand said.'],
    },
  },
  cutthroat: {
    kind: 'cutthroat', noun: 'brigand cutthroat', level: 6, health: [34, 40], damage: [3, 6], armour: 1, coin: [6, 15],
    carries: [['dirk', 0.8], ['leather_coat', 0.2]], flee: 0.15, hits: 'stabs', moves: 'drifts', street: false, named: true, corpse: 'street',
    aggressive: true, pack: true, bounty: 8, respawnMs: 15 * 60_000,
    card: {
      job: 'a brigand cutthroat, one of the captain\'s hard ones, in the camp in the Blackwood',
      personality: 'cold, quiet, patient, enjoys the work',
      speech: 'soft, unhurried, polite in a way that makes it worse',
      wants: 'the captain\'s favour, a clean kill, no witnesses',
      knows: 'the camp, the captain, the bend, how many pigeons came through this week',
      look: ['Quiet, neat and very still, with a dirk in each boot and nothing at all in the eyes.'],
      scripted: ['"Shh."', 'The cutthroat smiles without any warmth at all.'],
      ambient: ['The cutthroat sharpens a dirk on a stone, slowly.', 'The cutthroat watches the trees.'],
    },
  },
  bear: {
    kind: 'bear', noun: 'brown bear', level: 7, health: [50, 56], damage: [3, 7], armour: 2, coin: [0, 0],
    carries: [['bear_pelt', 1], ['bear_claw', 1]], flee: 0, hits: 'mauls', moves: 'lumbers', street: false, mute: true, named: false, corpse: 'beast',
    aggressive: true, respawnMs: 30 * 60_000,
    card: {
      job: 'a huge brown bear in its cave on the crags', personality: 'territorial, enormous, slow to anger and then unstoppable', speech: 'none', wants: 'its cave, alone',
      knows: 'the crags',
      look: ['A brown bear the size of a cart, rising onto its hind legs in the dark until its head brushes the roof. Its breath steams.'],
      scripted: ['The bear roars, a sound you feel in your teeth.', 'The bear swings its head, huffing.'],
      ambient: ['The bear shifts in the dark, huge and heavy.', 'The bear huffs, and the cave stinks of it.'],
    },
  },
  captain: {
    kind: 'captain', noun: 'brigand captain', level: 9, health: [70, 70], damage: [4, 8], armour: 2, coin: [20, 40],
    carries: [['camp_ledger', 1]], flee: 0, hits: 'cuts', moves: 'strides', street: false, named: false, corpse: 'street',
    aggressive: true, bounty: 25, respawnMs: 24 * 60 * 60_000, fixedName: 'the brigand captain',
    card: {
      job: 'the captain of the brigands of the north road, in a striped tent in the camp deep in the Blackwood',
      personality: 'charming, educated, utterly ruthless, a fallen gentleman who enjoys the theatre of it',
      speech: 'courteous, witty, elaborate, calls everyone my friend while measuring them for a shroud',
      wants: 'the road, the toll, and one day Vesna\'s gate open to them',
      knows: 'everything on the road; that Hook buys from them and Dace sells them the watch rota; that the blade came from somewhere far beyond the fog',
      look: ['A tall figure in a stained velvet coat over mail, with a fine grey beard and a long curved blade at the hip whose steel ripples like water.'],
      scripted: ['"My friend. You came all this way. How very brave."', 'The captain smiles and rests a hand on the hilt.'],
      ambient: ['The captain studies the maps, humming.', 'The captain pours wine into a silver cup that was once someone else\'s.'],
    },
  },
  wight: {
    kind: 'wight', noun: 'barrow wight', level: 8, health: [44, 44], damage: [3, 6], armour: 2, coin: [0, 0],
    carries: [], flee: 0, hits: 'claws', moves: 'drifts', street: false, mute: true, named: false, corpse: 'none',
    fixedName: 'the barrow wight',
    card: {
      job: 'the dead lord of the barrow, woken', personality: 'ancient, cold, wrathful, bound to the barrow', speech: 'none', wants: 'what was taken from it',
      knows: 'the dark',
      look: ['A tall shape of bone and rag and dark, crowned with dull gold, with two cold points of light where its eyes should be.'],
      scripted: ['The wight hisses like wind through a keyhole.', 'The wight reaches for you.'],
      ambient: ['The wight stands utterly still, watching the doorway.', 'Cold pours off the wight like water.'],
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

/** Beasts and brigands that live in one place: how many of each, and where. */
export const HOME_POP: Array<{ kind: MobKind; room: string; count: number }> = [
  { kind: 'rat', room: 'sewer_grate', count: 3 },
  { kind: 'big_rat', room: 'grate_tunnel', count: 2 },
  { kind: 'big_rat', room: 'overflow', count: 2 },
  { kind: 'giant_rat', room: 'old_cistern', count: 2 },
  { kind: 'cart_rat', room: 'bone_shelf', count: 1 },
  { kind: 'rat_king', room: 'the_nest', count: 1 },
  { kind: 'fox', room: 'ew_heath', count: 1 },
  { kind: 'fox', room: 'ew_runs', count: 1 },
  { kind: 'fox', room: 'ee_bracken', count: 1 },
  { kind: 'deer', room: 'ee_deerpath', count: 1 },
  { kind: 'deer', room: 'bw_trail', count: 1 },
  { kind: 'deer', room: 'bw_blind', count: 1 },
  { kind: 'goat', room: 'crag_goatpath', count: 2 },
  { kind: 'goat', room: 'crag_scree', count: 1 },
  { kind: 'wolf', room: 'ew_hollow', count: 1 },
  { kind: 'wolf', room: 'bw_dens', count: 3 },
  { kind: 'boar', room: 'bw_wallow', count: 2 },
  { kind: 'heron', room: 'mere_reeds', count: 1 },
  { kind: 'otter', room: 'falls_pool', count: 1 },
  { kind: 'brigand', room: 'camp_stockade', count: 2 },
  { kind: 'brigand', room: 'camp_tents', count: 2 },
  { kind: 'cutthroat', room: 'camp_tents', count: 1 },
  { kind: 'cutthroat', room: 'camp_lookout', count: 1 },
  { kind: 'bear', room: 'bear_cave', count: 1 },
  { kind: 'captain', room: 'captains_tent', count: 1 },
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
    const listName = spec.fixedName ?? (kind === 'rat_king' ? 'the rat king' : kind === 'dog' ? 'a stray dog' : `${a} ${spec.noun}`);
    const extra = spec.corpse === 'rat' ? ['rat'] : kind === 'dog' ? ['stray', 'mutt'] : kind === 'captain' ? ['captain', 'brigand'] : kind === 'wight' ? ['wight', 'dead'] : [];
    const keywords = [...new Set([...spec.noun.split(' '), spec.noun, ...extra])].filter(Boolean);
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
