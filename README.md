# Football Auction Platform

Local web app for football auction: an **Admin Console** (import players, set captains, assign female/predecided  layers, run the live auction) and a **Live Display** page for the big screen. Data is stored in plain JSON files under `/data`.

## Installing of Node.js

```
winget install -e --id OpenJS.NodeJS
```

```bash
npm install            # once, in the website folder
npm start
```

- Admin console: http://localhost:3000/admin/login.html
- Live display (projector / TV): http://localhost:3000/display/index.html

Login credentials as per current .env.example are -

username : admiralgeneralaladeen
password : aladeen

Other devices on your network can open the display using this PC's LAN IP instead of `localhost`.

## Before the auction — set-up order

1. **Import Sheet tab** — upload the workbook.
   - Needs a **Males** sheet and a **Females** sheet (names are matched loosely).
   - In Males, the **Predecided** column: `1` = not auctioned (the 6 captains + the 7th teammate), `0` = in the auction.
   - Females are never auctioned and are never shown on the live screen.
   - If you imported an older sheet earlier, first empty `data/players.json` (make it `[]`) and re-import,
     otherwise existing players are skipped and won't get the new gender / predecided info.
2. **Teams & Captains tab** — add the 6 teams and pick each team's **captain from the drop-down**
   (predecided players are listed first). Captains cost nothing: every team keeps the fixed 1,000M purse.
   The captain can be changed later from the same drop-down.
3. **Teams & Captains tab, lower table** — once the captains are chosen, the one remaining predecided
   player (teammate of the injured player) is left there; choose his team.
4. **Female Players tab** — choose a team for each female player. Admin-only: the live display never
   shows female players or which team they joined, and its squad counts exclude them.
5. *(Optional)* **Bulk Photo Upload** — photos named `Full_Name.jpg` (spaces → underscores) are matched to players.

## Running the auction

- **Live Auction tab → Start** (Round 1). Based on the order of data present in the excel sheet uploaded.
- Click a team's button to record its bid; the button shows the exact next legal amount (5 / 10 / 20 M raise tiers)
  and is disabled if the team can't afford it or already leads.
- **Timer:** a new player starts with a **20 s** window; every bid restarts it at **10 s**
  (both editable in `services/biddingRules.js`). It is only a visual guide — at zero the ring turns red and shows
  **TIME UP**, and *nothing happens automatically*. **You** press **Mark Sold** or **Mark Unsold**.
  Pause freezes the countdown; Resume continues from where it stopped.
- A 2-minute break starts after every 15 players — press **Resume From Break** when ready.
- **Round 2** (from the round drop-down) re-auctions everyone marked unsold in Round 1.
- **Unsold Pool** handles players still unsold after Round 2 (team requests + random allocation).
- **Transfers** logs post-auction swaps (captains can't be transferred).

## Currency

Values are shown as `€40M`, `€1,000M`. To use pounds, put `CURRENCY_SYMBOL=£` in `.env`.

## Things worth knowing

- **Squad counts:** "Male Squad" = captain + pre-assigned + auction buys. Females are counted separately
  (admin only). The 16-player auction cap counts only players won in the auction rounds.
- **Editing the JSON files by hand** is safe when the server is stopped or the auction is paused. Back up `/data` before each round.
- **Public screen privacy:** the live display only receives name, category, positions, club, experience, photo and base price —
  no emails or roll numbers.
- Tie-breaking (rule 18) stays a manual call: with a single admin clicking bids, whichever click arrives first wins.
