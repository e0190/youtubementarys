// Playlist detail — works for both curated (repo) and viewer-created playlists.

import { el, compact, durationWords } from '../util.js';
import {
  store, getPlaylist, userPlaylist, playlistVideos, getChannel, viewsOf,
  updatePlaylist, deletePlaylist,
} from '../store.js';
import {
  videoCard, avatar, grid, emptyState, button, toast, confirmDialog, modal,
  thumbImage,
} from '../components.js';
import { href, navigate } from '../router.js';
import { setView } from '../app.js';

export default function playlistView({ params }) {
  const owned = userPlaylist(params.id);
  const playlist = owned || getPlaylist(params.id);

  if (!playlist) {
    if (!store.ready) { setView(el('div', { class: 'skel', style: { height: '200px' } })); return; }
    setView(emptyState('library', 'Playlist not found',
      'This playlist no longer exists, or it was created on another device.',
      button('Your playlists', { variant: 'primary', onClick: () => navigate('/playlists') })),
      { title: 'Playlist not found' });
    return;
  }

  const videos = playlistVideos(playlist);
  const channel = playlist.channelId ? getChannel(playlist.channelId) : null;
  const totalSeconds = videos.reduce((sum, v) => sum + (v.durationSec || 0), 0);
  const totalViews = videos.reduce((sum, v) => sum + viewsOf(v), 0);

  const rerender = () => playlistView({ params });

  const actions = el('div', { class: 'series-hero-actions' },
    videos.length
      ? button('Play all', {
          variant: 'brand',
          onClick: () => navigate('/watch', { v: videos[0].id, list: playlist.id }),
        })
      : null,
    videos.length > 1
      ? button('Shuffle', {
          variant: 'subtle',
          onClick: () => {
            const pick = videos[Math.floor(Math.random() * videos.length)];
            navigate('/watch', { v: pick.id, list: playlist.id });
          },
        })
      : null,
    owned ? button('Edit', { variant: 'subtle', onClick: () => openEditor(playlist, rerender) }) : null,
    owned
      ? button('Delete', {
          variant: 'ghost', icon: 'trash',
          onClick: async () => {
            const ok = await confirmDialog('Delete playlist?',
              `“${playlist.title}” will be removed. The videos themselves stay in the catalog.`);
            if (!ok) return;
            deletePlaylist(playlist.id);
            toast('Playlist deleted');
            navigate('/playlists');
          },
        })
      : null);

  const header = el('section', { class: 'series-hero' },
    videos[0]
      ? el('div', { class: 'series-hero-bg' }, thumbImage(videos[0]))
      : null,
    el('div', { class: 'series-hero-body' },
      el('h1', { class: 'series-hero-title' }, playlist.title),
      el('div', { class: 'series-hero-meta' },
        [channel?.name,
         owned ? (playlist.visibility === 'public' ? 'Public playlist' : 'Private playlist') : 'Playlist',
         `${videos.length} ${videos.length === 1 ? 'title' : 'titles'}`,
         totalSeconds ? durationWords(totalSeconds) : null,
         totalViews ? `${compact(totalViews)} views` : null].filter(Boolean).join(' · ')),
      playlist.description ? el('p', { class: 'series-hero-desc' }, playlist.description) : null,
      channel
        ? el('a', {
            class: 'btn btn-subtle', style: { marginTop: '.75rem' },
            href: href(`/channel/${channel.handle || channel.id}`),
          }, avatar(channel, 20), el('span', {}, channel.name))
        : null,
      actions));

  const body = videos.length
    ? grid(videos.map((v, i) => videoCard(v, {
        layout: 'row',
        index: i + 1,
        playlistId: owned ? playlist.id : null,
        onRemove: owned ? rerender : null,
      })), { className: 'results-list' })
    : emptyState('library', 'This playlist is empty',
        owned
          ? 'Use the ⋮ menu on any video card to add titles here.'
          : 'Nothing has been added to this playlist yet.',
        button('Browse the catalog', { variant: 'primary', onClick: () => navigate('/') }));

  setView([header, body], { title: playlist.title });
}

function openEditor(playlist, rerender) {
  const title = el('input', { class: 'input', value: playlist.title, maxlength: '100' });
  const description = el('textarea', { class: 'textarea', maxlength: '1000' });
  description.value = playlist.description || '';
  const visibility = el('select', { class: 'select' },
    el('option', { value: 'private', selected: playlist.visibility !== 'public' || null }, 'Private'),
    el('option', { value: 'public', selected: playlist.visibility === 'public' || null }, 'Public'));

  modal({
    title: 'Edit playlist',
    body: el('div', { class: 'form-grid' },
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Name'), title),
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Description'), description),
      el('div', { class: 'form-row' }, el('label', { class: 'form-label' }, 'Visibility'), visibility)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: () => {
          const name = title.value.trim();
          if (!name) { title.focus(); return false; }
          updatePlaylist(playlist.id, {
            title: name,
            description: description.value.trim(),
            visibility: visibility.value,
          });
          toast('Playlist updated');
          rerender();
        },
      },
    ],
  });
}
