// Dashboard settings. Edit and push; the site redeploys automatically.
window.TRACKER_CONFIG = {
  defaultTeam: null,           // slug to follow when a visitor hasn't picked one (null = whole race)
  sourceUrl: 'https://schools.tks.world/high-agency-fund',
  votingClosesAt: '2026-11-01T03:59:00Z',   // Oct 31, 11:59 PM Toronto (EDT)
  fundedSpots: 5,
  refreshSeconds: 20,          // how often this page checks for new snapshots
  staleAfterMinutes: 15,       // flag data as stale after this long without a successful collection
  // Where to read fresh data between site deploys. Auto-detected on USERNAME.github.io/REPO;
  // set explicitly if you use a custom domain, e.g. { owner: 'you', name: 'repo', branch: 'main' }.
  repo: null,
};
