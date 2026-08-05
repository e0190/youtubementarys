// Site-wide configuration.
//
// The catalog (channels/videos/series/playlists) is read from the `data/` folder
// in this repo. Reads are anonymous. Writes — publishing a video from Studio, or
// syncing a viewer's history/subscriptions — go through the GitHub Contents API
// and require a token.
//
// SECURITY: anything you put in `token` below is shipped to every visitor's
// browser and is trivially readable. Leave it empty for public deployments and
// let people paste their own token in Settings. Only fill it in if you have
// deliberately accepted that exposure (a fine-grained token scoped to *only*
// this repo's contents keeps the blast radius small).

export const REPO = {
  owner: 'e0190',
  repo: 'youtubementarys',
  branch: 'main',
  token: '', // leave empty — see note above
};

export const SITE = {
  name: 'YoutubeMentries',
  short: 'Mentries',
  tagline: 'Documentaries and docuseries, all in one place.',
};

export const PATHS = {
  channels: 'data/channels.json',
  videos: 'data/videos.json',
  series: 'data/series.json',
  playlists: 'data/playlists.json',
  comments: (videoId) => `data/comments/${videoId}.json`,
  user: (userId) => `data/users/${userId}.json`,
};

// localStorage keys.
export const LS = {
  token: 'ym.token',
  user: 'ym.user',
  userId: 'ym.userId',
  settings: 'ym.settings',
  catalogCache: 'ym.catalogCache',
};

// Topic chips shown on the home feed. The first entry is always "All".
export const TOPICS = [
  'Nature', 'Space', 'History', 'True Crime', 'Science', 'Technology',
  'Wildlife', 'Music', 'Art', 'Food', 'Travel', 'Sports', 'Politics',
  'Economics', 'Health', 'Environment', 'Biography', 'War', 'Archaeology',
];

export const DEFAULT_SETTINGS = {
  theme: 'dark',        // 'dark' | 'light' | 'system'
  autoplay: true,
  rate: 1,
  volume: 1,
  muted: false,
  quality: 'auto',
  sync: true,           // push local data to GitHub when a token is available
  reducedMotion: false,
};
