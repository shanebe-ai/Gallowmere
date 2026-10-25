# Gallowmere: A Guide for the Newly Arrived

*Found nailed to the inside of the North Gate. Someone has corrected the spelling in two places and added a rude drawing in a third.*

So. You came out of the fog.

Everyone does, eventually. The moor spits you out at the North Gate with wet boots and no idea where you are, and the gibbet over the arch creaks a welcome. Don't look up at it for too long. The last one who did is still up there.

This is Gallowmere. A walled river town that should have died a hundred years ago and didn't have the decency to. The watch is lazy, the temple sells its mercy by the coin, the docks smuggle anything that fits in a crate, and the sewers have rats the size of dogs. Magic is rare. Honesty is rarer.

And the people here remember you. Every word, every slight, every coin you didn't pay. Keep that in mind.

## Getting in

There are two doors into town.

**The browser.** Open `http://37.27.80.77:3004` and you'll get a green screen terminal. Works on a phone too. Exits and names on screen can be tapped.

**Telnet.** For the old guard, or anyone using Mudlet or another MUD client:

```
telnet 37.27.80.77 4004
```

Same town, same people, same fog. Folk on telnet and folk in the browser stand in the same rooms and hear the same lies.

A word of warning: telnet sends everything in the clear, your password included. If you care who reads it, use the browser.

### Your name

The gate asks your name. Letters only, 3 to 16 of them. If nobody here goes by it, you'll be asked if you want to become them. Pick a password, 6 characters or more, and type it twice.

Forget it and you'll stay forgotten. Guess wrong too many times and the town locks your name for a while. Gallowmere doesn't trust anyone who can't remember who they are.

## Finding your feet

**Look around.** `look`, or just `l`. You'll get the room, then three lines worth reading:

```
The Drowned Rat
A low ceilinged tavern, warm and loud and sticky underfoot...
People:  Morda the barkeep
Players: Bob
You see: the stained curtain, the dice game
Exits: north.
```

* **People** are the townsfolk. Talk to them, look at them, poke them if you're feeling brave.
* **Players** are other poor souls like you.
* **You see** is everything worth touching. All of it can be used.
* **Exits** are where you can go. Mostly.

**Walk.** `north`, `south`, `east`, `west`, `up`, `down`. Or `n` `s` `e` `w` `u` `d` if your feet are in a hurry. In the browser you can tap the exit buttons under the text.

**Look closer.** `look curtain`, `look at the barkeep`, `l dice`. Looking at a thing tells you what it responds to:

```
> look at the curtain
A heavy curtain, stained with things best left unnamed...
You could: open, take, touch.
```

## Talking

Talk is cheap in Gallowmere. Everything else costs.

**Say something to the room:** `say evening all`, or the short way, `' evening all`.

**Talk to someone:** say their name and they'll hear you.

```
' evening Morda
hello guard
say to guard nice weather
talk morda I'm looking for work
ask morda about the docks
ask morda who runs the docks?
```

Once you've got Morda talking, you can keep going without her name. Just `say` it, or `ask` it, and she'll know it's for her. If she's the only soul in the room, she'll assume you mean her anyway. Walk away, or start talking to someone else by name, and she'll let you go.

**Act it out:** `emote leans on the bar`, or `: leans on the bar`. The room sees *"Shane leans on the bar."*

**See who's about:** `who` lists everyone in town and where they're standing.

**Lost?** Type `hint`. The town will nudge you, and tell you the way.

## Doing things

Everything listed under **You see** can be handled. Some of it will even let you.

```
take the curtain        read board          sit in the stocks
pull the curtain        search the altar    knock on the shed
play dice               climb the fountain  smell the eels
pick up the ledger      touch the grate     kick the barrels
```

Plain words work. *"Look at the curtain"* and *"look curtain"* are the same thing. So are *grab*, *take*, *steal* and *pick up*.

People can be handled too, though they may not thank you for it. `poke morda`. `shove guard`. `poke bob`. Everyone in the room sees it, and the townsfolk remember.

Mind whose house you're in. Yank the curtain in Morda's tavern, or snatch the dice off her regulars' table, and she will have words. Morda always has words.

**Your pack.** `i` shows what you carry and your coin. `take`, `drop` and `give` do what you'd think: `take rope`, `drop the nail`, `give bread to bob`. Your pack holds 20 weight, and a coil of rope weighs 3, so choose. Things you carry can be used too: `eat bread`, `drink ale`, `light lamp`, `open locket`.

Nobody starves in Gallowmere, whatever it looks like. Food and ale are a comfort, not a chore.

## Coin

You come out of the fog with 10 coin. It won't last.

**Earning it**

* **Honest work.** Maud at Market East always has a sack of turnips waiting at the fish market. Type `work` in her shop, fetch it, `give sack to maud`, get paid. Once an hour, and she pays like each coin hurts.
* **Scavenging.** The town throws things away and some of them are worth a copper. `search` the gutters at the fish market, the midden in the Rat's yard, the junk in the market cellars, the floats in the net loft, the ribs of the hulk. Each spot gives once an hour.
* **Selling.** Tilly buys junk and trinkets at fixed prices. Maud buys food and tools. Hamo buys iron. And there's a man who buys everything, if you can find him.

**Spending it**

`list` shows what a shopkeeper sells. `buy rope` pays the asking price. Or haggle:

```
> buy rope for 3
You offer 3 coin for a coil of rope.
Maud says to you, "Five. And that's me being soft."
Maud's price: 5 coin. Type accept, offer <amount>, or walk away.
> ' it's half rotten, Maud
Maud says to you, "Four, then, and get out of my shop."
> accept
You buy a coil of rope for 4 coin.
```

Talk while you haggle and they'll answer with a price. Every shopkeeper has a line they won't go under, however sweet you talk. Insult one enough and they'll stop serving you for a while.

Selling works the same way: `sell lamp` takes their offer, `sell lamp for 5` starts the argument. `appraise` asks what they'd pay. Shops only carry so much coin a day. When they're spent out, come back tomorrow.

**Standing.** The townsfolk keep score. Pay fair, do the work, come back, and prices drift your way. Get thrown out and they drift the other way.

**The counting house.** Ingelram keeps coin behind iron bars, south of Market East. `deposit 5`, `withdraw 5`, `balance`. He takes one copper in twenty on the way out. Pay it. When the plague cart starts rolling, banked coin is the only coin that's safe.

**Bribes.** Some people in Gallowmere can be bought. `bribe dace 3`. Too little and he'll look at it like something the dog brought in. Enough and he'll lean in close and tell you something worth knowing.

## The town, as far as you're allowed to see it

**The North Gate.** The only road in. A rusted portcullis, a gate guard with his hand out and a gibbet that's never quite empty. Stairs climb to the wall walk. North, the moor road runs out across the heather, ten miles to a town called Vesna.

**Gate Road and the Barracks.** Shuttered houses that listen. The watch drills in the yard when it can be bothered. Read the notice board. Someone named Dace keeps coming up. The watch house, the captain's office and the lockup are north of the yard. The captain is never in.

**The Temple of Ash.** Healing is sold here, they say, to those who can pay. The saint on the wall had her eyes scratched out long ago. Someone has painted her a smile. Past the altar: the nave, the healer's ward, an ossuary of painted skulls, and a bell tower with a cracked bell. Ring it if you want every dog in town to hate you.

**The Market.** Rope, oil, eels that haven't finished dying, and a founder's statue with no nose. Pickpockets work the crowd. Keep a hand on your purse. Maud's Provisions, the counting house and Butcher's Alley sit off Market East. Old Tilly's curios are north of Market West. The market cellars are under the square, and things get lost down there.

**Smithy Row.** The hammer never stops. Hamo sells knives, tools and, at last, the real blades from under the tarp. Coats and jerkins too, for those who'd rather not bleed.

**The Drowned Rat.** The only warm room in town. Rooms upstairs, a dice cellar below for the serious games, a yard out back. Mind the curtain on the west wall. Nobody looks at it for long. Through the yard, the Sleeping Lantern: Old Peg's inn, where the beds are clean and nobody gets stabbed.

**The Gatherers' Hall.** East off Butcher's Alley, cold and scrubbed and smelling of lime. Warden Crane pays for the dead, by the body, and writes every one of them down.

**Wet Lane and the Docks.** Never dry, never honest. The fish market, the harbourmaster's office, the net loft and a beached wreck called The Patience. The harbourmaster takes bribes on Tuesdays. Today is not Tuesday.

**The Sewers.** Iron bars bent wide enough for someone thin. Down through them, a tunnel, an overflow, and at the end an iron door, chained and painted red: DO NOT. Something on the other side knocks. If you get through, there's a cistern of black water, a shelf of bones the cart men tip there, a passage up to the old wreck, and a nest. Don't go in the nest.

## Beyond the wall

The fog has drawn back from the moor road at last.

**The road.** Ten rooms of rutted dirt north from the Moor Road: Heather Rise, the Gibbet Milestone, Drovers' Ford, the Toll Stump, Brigand's Bend, the Burnt Waystation, Mile Oak, the Long Climb, and at the end the shut gate of Vesna. Knock if you like. Someone always answers. Nobody opens it.

**The forest.** Woods all round the road, in places with their own names and their own business. The Edgewood is thin and friendly, mostly. West of the ford a black lake lies still as tar, with a jetty, a ferryman and an island. Up the stream, a waterfall. West of the Long Climb, the crags, the goats, and a cave that smells of bear. East of the Toll Stump the trees go black and close: the Blackwood, wolves, boar, and somewhere deep in it, the brigands' camp. And south east, past the bracken, a ring of old stones and a mound nobody digs into. Walk into the fog at the edges and you'll come back where you went in, colder.

**Brigands.** They wait at Brigand's Bend and ask a toll: `pay` and walk on poorer, or fight. They never trouble anyone in their first two hours. The watch pays bounties on brigands, more on their cutthroats, and a great deal on their captain.

**The shrine.** Up the stone steps from Mile Oak, through a tunnel of red gates, an old woman keeps a small wooden shrine. It asks for calm, not coin. Keep to the side of the path through the gates. Purify at the water basin, then at the shrine `offer 1`, `ring bell`, `bow`, `bow`, `clap`, `clap`, `pray`, `bow`. Do it right and, once a day, it closes every wound you have. Draw a fortune at the tree behind it for a coin. If it's bad, tie it to the tree and leave it there.

**Living off the land.** Maud sells rods. `dig` for worms in soft wet ground, or use bread, then `fish` at the docks, the ford, the lake or the plunge pool. Gather sticks in the woods (`take stick`). `make` turns junk into torches, bandages, bait, snares and campfire stew; `recipes` lists them. Set a snare on a rabbit run in the Edgewood and come back later. Pelts, hides, meat and fish all sell, and Morda will cook whatever you bring her, for a coin.

**The dark.** Some places are dark. Without a light you'll see nothing at all. Light a torch, a candle or a lamp first.

**Surprises.** There are things out there nobody will tell you about straight. Listen to the people who live out there. Look closely. Go back to places at different times.

## The people

**Morda, barkeep of The Drowned Rat.** Broad, tired, misses nothing. She calls strangers *damp one* and regulars by name. Pay, behave, don't bleed on her floor, and she'll warm to you, slowly. Tell her who you are and she'll remember it next time you come in. Cross her and she'll remember that too. She can turn her back on you, and she will.

**Dace, the gate guard.** A thin man in a helmet two sizes too big. Leans on his spear more than he holds it. Says the toll is waived today. Doesn't say why. Knows everyone who's come through the gate, and sells what he knows.

**Hamo Crump, the blacksmith.** Crooked back, singed eyebrows, deaf to anything quieter than his hammer. Fair prices, firm. Judges you by your hands.

**Maud Cumin, the grocer.** Short, wide and sharp as a nail. Counts while you talk. Pays for honest work, haggles one copper at a time and enjoys it more than she lets on. Don't ask about the lamp oil.

**Father Osmund.** Tall, stooped, kind and tired, with a cup of something that isn't communion wine. Sells candles, bandages and holy water. Buy the bandages.

**Tilly.** Ancient, wrapped in shawls, one good eye. Buys junk and trinkets, sells them back dearer, never haggles. Don't touch the heron. His name is Gerald.

**Ingelram.** The clerk at the counting house. Weighs every coin twice and trusts neither result.

**Hook.** You won't find him on any sign. Ask around. Pay Dace. Look above the fish. He buys anything, sells strange things, and keeps a ledger with half the town in it.

**The beggar in Wet Lane.** One eye open, always watching the market road. He saw the watch take a bribe this morning. Nobody listens to him.

**The rats.** Big ones. Bigger than rats should be. They don't run from you. They fight back. Think about that.

**Out past the wall.** Cole the charcoal burner, grey with soot, who buys hides and sells torches. The old ferryman on the mere, who says very little and most of it about a fish. The shrine keeper, who will show you how without a word of reproach. And whoever it is behind the gate of Vesna.

**Around town.** The duty sergeant at the watch house, who pays bounties and hates paperwork. Bess the fishwife and Hook's runner Nib at the fish market. Amos the gravedigger, far too cheerful, in the ossuary. Tobin the lamplighter, who walks every street and sees who goes where after dark. Wendel, who has propped up the end of Morda's bar for twenty years. Warden Crane of the Gatherers. Old Peg at the Sleeping Lantern.

**The street folk.** Different faces every day. Drunks, rag pickers, a preacher, cutpurses, rat catchers, bruisers. They'll talk if you talk to them, and every one of them has something on their mind.

## Steel and blood

You'll want to know about fighting. Everyone does.

**The streets are full of people you can hurt.** Drunks, rag pickers, a mad preacher, cutpurses, rat catchers, dock bruisers, stray dogs. They wander, they mutter, and now and then they fall out with each other and you can watch, or join in. `consider wat` tells you how a fight would likely go. `attack wat` starts one. The townsfolk with names you know, Morda and the rest, are not for fighting. The whole town would hang you.

**A fight runs on its own.** Blows land every few seconds until someone drops, runs or is dragged off. Your health is in the status bar and goes amber, then red. `flee` takes you out through a random door, if you're lucky. You can't just walk away mid fight. Type `health` any time to see how badly you're hurt, what your weapon does and how your odds look.

**Arm yourself.** Hamo has finally put edges on the blades: a knife, a cudgel, a hatchet, a short sword, and a padded jerkin or a leather coat if you'd rather not bleed. `wield cudgel`, `wear jerkin`. Fists work, barely.

**Where you can't fight.** The temple and everything under its roof, and the counting house. Father Osmund's glare is worth a dozen guards. The Drowned Rat isn't holy, but start a fight there and Morda throws you into the mud. Both of you.

**Other players.** Fair game, outside the temple and the bank. Except the newly arrived: for their first two hours nobody can lay a hand on them, and they can't lay one on anybody.

**Death.** It isn't the end, but it costs. You wake on the cold floor of the Temple of Ash with a grave chill: half your health and a shaky arm for ten minutes. Your coin and your pack stay on your corpse where you fell. For ten minutes only you can touch it. After that, anyone can. After half an hour it's gone. Or pay Father Osmund to send a boy for it. Banked coin never moves. The newly arrived keep their things.

**Getting about.** You keep a notebook: `journal`, or just `j`. Father Osmund has tucked a note inside the cover, and the nave is already in it, so `travel nave` works from your first minute. It lists every useful place you've found, who's there, what they buy and sell, and the word to travel there. Once you've found a place on foot, `travel` takes you back there, one room at a time: `travel nave`, `travel tavern`, `travel bank`. It's still the streets. A fight stops you, the cart can catch you, and typing anything stops you where you stand. When it's going badly, a pilgrim's token from Father Osmund will do better: `crush token` and you're kneeling in the nave. Not with someone's hands on you, though.

**Healing.** Wounds close slowly on their own, faster by the fire in the Drowned Rat or on a bench in the nave. Bandages help (`bandage`). Morda's stew helps. Father Osmund will make you whole for a few coin (`heal`).

**The plague cart.** At no fixed hour, every hour or two, the cracked bell in the temple's bell tower tolls. A couple of minutes later the cart sets out from the temple steps and works its way through every street, down to the river. It takes every body it passes and everything on them, and it all ends up in Hook's back room, where you can buy it back if you can afford him. The cart men take a quarter of the coin in your purse, and anyone too badly hurt to stand goes on the cart with the dead. Get indoors when you hear the bell. Bank your coin before you do.

**The dead pay, if you're not squeamish.** `loot corpse` takes what a body carried. `take corpse` puts it over your shoulder. Carry a body to Father Osmund in the nave and he'll pay for the burial. The butcher pays more, and doesn't ask, and word gets around. Carry another player's body to the temple and Osmund sends their things home to them, and pays you for the kindness.

**The Gatherers' Hall.** Crane pays best for the dead. `join gatherers` for a coin, then carry bodies in and `deliver`. Fresh ones pay full; after a quarter of an hour, half; after twenty five minutes she won't take them. A rat is a coin, street folk three to five, beasts and brigands six to ten, the brigand captain twenty five. `board` shows who wants which bodies this hour, and pays their price. The more you bring, the higher your rank, and each rank is worth a coin more a body.

**Drink.** Ale and Morda's rotgut gin add up. Merry heals you a little. Tipsy, you burp. Drunk, your words slur, your feet take wrong turns, your aim goes, and Morda cuts you off. Legless, you're out cold in the road, where cutpurses go through your pockets and the cart men take you for dead. Water, food and sleep sober you up. `health` tells you how far gone you are.

**The Sleeping Lantern.** `rent bed` (2 coin) or `rent room` (6 coin, private, with a chest), then `sleep`. You wake whole and clear headed. `store` and `retrieve` keep things safe in your room's chest while you're out on the road. Sleep in the street instead and you take your chances.

**Bounties and tails.** The watch house pays for every cutpurse you put down (`bounty`), and for brigands too. Maud pays a copper for every rat tail. The rats are under the grate.

**The sewers.** Rats by the grate, bigger ones in the tunnels. The iron door at the end opens for a key, or for someone strong enough to force it. Hook sells keys. Rat catchers sometimes carry one. What's behind it is the worst fight in Gallowmere, and it comes back every day.

## Manners

Gallowmere isn't a nice town, but it has rules.

* **The townsfolk remember.** Morda, Dace, Hamo, Maud, Father Osmund and Hook all keep notes on you. What you say, what you do, how you paid. It follows you between visits.
* **Some words don't get said here.** Slurs catch in your throat and go nowhere. Try it and the attempt is noted.
* **Don't flood.** More than ten commands a second and the fog tells you to slow down, and drops the rest.
* **No bots, no scripts.** Play it yourself.
* **One body each.** Log in somewhere else and your old connection gets shown the door.

## Quick reference

| What | Type |
| --- | --- |
| Look around | `look`, `l` |
| Look at something | `look curtain`, `l morda`, `x dice` |
| Move | `n` `s` `e` `w` `u` `d`, or the full word |
| Say | `say hello`, `' hello` |
| Talk to someone | `' evening Morda`, `hello guard`, `talk morda ...` |
| Ask about something | `ask morda about the docks` or `ask morda who runs the docks?` |
| Act | `: leans on the bar`, `emote ...` |
| Emotes | `wave`, `laugh at bob`, `nod morda`, `hug tilly`, `dance wildly`; `emotes` lists them all |
| Use things | `take`, `touch`, `open`, `pull`, `push`, `knock`, `read`, `search`, `smell`, `sit`, `climb`, `play`, `drink`, `kick` |
| Your pack | `i`, `take`, `drop`, `give bread to bob`, `give 2 coins to morda` |
| Eat, drink, use | `eat bread`, `drink ale`, `light lamp`, `read`, `open` |
| Shops | `list`, `buy rope`, `buy rope for 3`, `sell lamp`, `sell lamp for 5`, `appraise` |
| Haggling | `offer 4`, `accept`, `walk away`, or just talk |
| Bank | `deposit 5`, `withdraw 5`, `balance` |
| Work | `work` in Maud's shop |
| Bribes | `bribe dace 3` |
| What now? | `hint` |
| Fight | `consider wat`, `attack wat`, `flee` |
| Your body | `health` (or `hp`): wounds, weapon damage, armour, your odds |
| Your notebook | `journal` (or `j`): the useful places you've found, what's there, and the word to travel there |
| Get somewhere | `travel nave`, `travel tavern`, `travel` on its own for the places you know |
| Get out | `crush token` (a pilgrim's token from Father Osmund), `crush charm` (a fox charm from the shrine keeper) |
| Arm up | `wield cudgel`, `wear jerkin`, `remove` |
| Heal | `bandage`, `heal` (in the nave) |
| The dead | `loot corpse`, `take corpse`, `give corpse to osmund`, `sell corpse to butcher`, `recover` (in the nave) |
| Bounties | `bounty` at the watch house |
| The shrine | `purify`, `offer 1`, `ring bell`, `bow`, `clap`, `pray`, `draw fortune`, `tie fortune`, `keep to the side` |
| The road | `pay` (a toll), `knock gate`, `ferry` |
| Fish and forage | `fish`, `dig`, `take stick`, `set snare`, `check snare` |
| Make things | `recipes`, `make torch`, `light torch` |
| Gatherers | `join gatherers`, `deliver`, `board` |
| The inn | `rent bed`, `rent room`, `sleep`, `store bread`, `retrieve bread` |
| Who's in town | `who` |
| Your details | `score` |
| Shortcuts | `alias tm talk morda`, then `tm hello` |
| Remove a shortcut | `unalias tm` |
| Help | `help`, `help say`, `?` |
| Leave | `quit` |

*At the bottom, in a different hand: "Back room. Ledger. Hook. You didn't hear it from me."*
