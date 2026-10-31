// Dashboard settings. Edit and push; the site redeploys automatically.
window.TRACKER_CONFIG = {
  defaultTeam: null,           // slug to follow when a visitor hasn't picked one (null = whole race)
  sourceUrl: 'https://schools.tks.world/high-agency-fund',
  votingClosesAt: '2026-11-01T03:59:00Z',   // Oct 31, 11:59 PM Toronto (EDT)
  fundedSpots: 5,
  refreshSeconds: 20,          // how often this page checks for new snapshots
  staleAfterMinutes: 15,       // flag data as stale after this long without a successful collection
  // Where to read fresh vote data between deploys (the GitHub repo the collector writes to).
  // Needed on Vercel or a custom domain; on USERNAME.github.io/REPO it is detected automatically.
  repo: { owner: 'Eben-Siyabalapitiya', name: 'haf-tracker', branch: 'main' },
};
