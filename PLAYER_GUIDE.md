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
```

Once you've got Morda talking, you can keep going without her name. Just `say` it, and she'll know it's for her. Walk away, or start talking to someone else by name, and she'll let you go.

**Act it out:** `emote leans on the bar`, or `: leans on the bar`. The room sees *"Shane leans on the bar."*

**See who's about:** `who` lists everyone in town and where they're standing.

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

## The town, as far as you're allowed to see it

**The North Gate.** The only road in. A rusted portcullis, a bored guard and a gibbet that's never quite empty.

**Gate Road and the Barracks.** Shuttered houses that listen. The watch drills in the yard when it can be bothered. Read the notice board. Someone named Dace keeps coming up.

**The Temple of Ash.** Healing is sold here, they say, to those who can pay. The saint on the wall had her eyes scratched out long ago. Someone has painted her a smile.

**The Market.** Rope, oil, eels that haven't finished dying, and a founder's statue with no nose. Pickpockets work the crowd. Keep a hand on your purse. Keep the other on your knife, once you have one.

**Smithy Row.** The hammer never stops. The blades aren't for sale. Yet.

**The Drowned Rat.** The only warm room in town. Mind the curtain on the west wall. Nobody looks at it for long.

**Wet Lane and the Docks.** Never dry, never honest. The harbourmaster takes bribes on Tuesdays. Today is not Tuesday.

**The Sewer Grate.** Iron bars bent wide enough for someone thin. Something down there is scratching. A lot of somethings.

## The people

**Morda, barkeep of The Drowned Rat.** Broad, tired, misses nothing. She calls strangers *damp one* and regulars by name. Pay, behave, don't bleed on her floor, and she'll warm to you, slowly. Tell her who you are and she'll remember it next time you come in. Cross her and she'll remember that too. She can turn her back on you, and she will.

**The gate guard.** A thin man in a helmet two sizes too big. Leans on his spear more than he holds it. Says the toll is waived today. Doesn't say why.

**The blacksmith.** Soot black, singed eyebrows, deaf to anything quieter than his hammer. Not selling. Not yet.

**The beggar in Wet Lane.** One eye open, always watching the market road. He saw the watch take a bribe this morning. Nobody listens to him.

**The rats.** Big ones. Bigger than rats should be. They don't run from you. Think about that.

## Steel and blood

You'll want to know about fighting. Everyone does.

Not yet.

Try `attack` and you'll size them up and think better of it. Gallowmere isn't ready to bleed for you. Soon, though. The blacksmith is putting edges on those blades for a reason, and the scratching under the grate is getting louder.

When steel comes to Gallowmere, this is what the old hands say it'll be like:

* **It's about the body, not a number.** Blows land on a head, a chest, an arm, a leg. Lose your sword arm and your sword hits the cobbles. Only a ruined head or body puts you down for good.
* **Death has a price.** The Temple of Ash will bring you back, for a fee. Don't expect a discount.
* **The plague cart comes every night.** Whatever you haven't banked by the time it rolls through is gone. You'll get a warning an hour before. Listen to it.
* **The watch remembers.** Rob the grocer and the captain hears about it. The barkeep mentions it the next night. The grocer charges you double for the rest of your life.
* **The sewers come first.** Rats, then whatever the rats are afraid of.

Until then, keep your knuckles to yourself and your ears open.

## Manners

Gallowmere isn't a nice town, but it has rules.

* **The townsfolk remember.** Morda, and soon the others, keep notes on you. What you say, what you do, who you are. It follows you between visits.
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
| Ask about something | `ask morda about the docks` |
| Act | `: leans on the bar`, `emote ...` |
| Use things | `take`, `touch`, `open`, `pull`, `push`, `knock`, `read`, `search`, `smell`, `sit`, `climb`, `play`, `drink`, `kick` |
| Who's in town | `who` |
| Your details | `score` |
| Shortcuts | `alias tm talk morda`, then `tm hello` |
| Remove a shortcut | `unalias tm` |
| Help | `help`, `help say`, `?` |
| Leave | `quit` |

*At the bottom, in a different hand: "Back room. Ledger. Hook. You didn't hear it from me."*
