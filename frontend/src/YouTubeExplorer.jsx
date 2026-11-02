import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Check, ChevronLeft, ChevronRight, Clock3, LoaderCircle, Minimize2, PictureInPicture2, Play, Search, X } from 'lucide-react';
import { searchYouTubeVideos } from './services/aiService.js';
import './YouTubeExplorer.css';

const SKELETON_COUNT = 6;
const WATCH_LATER_KEY = 'prep-youtube-watch-later-v1';
const RELATED_SEARCHES = [
  'Telangana GK',
  'Indian Polity for competitive exams',
  'Arithmetic practice for SI exams',
  'Reasoning shortcuts',
  'English grammar for competitive exams'
];

function readWatchLater() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_LATER_KEY) || '[]');
    return {
      videos: Array.isArray(saved) ? saved.filter((video) => video && /^[A-Za-z0-9_-]{11}$/.test(video.videoId)) : [],
      error: ''
    };
  } catch {
    return { videos: [], error: 'Watch Later could not be loaded from this browser.' };
  }
}

function formatPublishedDate(value) {
  if (!value) return 'Publication date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Publication date unavailable';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatVideoDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return 'Duration unavailable';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export default function YouTubeExplorer({ onNavigate }) {
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q')?.slice(0, 100) || '');
  const [videos, setVideos] = useState([]);
  const [watchLater, setWatchLater] = useState(readWatchLater);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [submittedDuration, setSubmittedDuration] = useState('any');
  const [submittedOrder, setSubmittedOrder] = useState('relevance');
  const [submittedLanguage, setSubmittedLanguage] = useState('all');
  const [nextPageToken, setNextPageToken] = useState('');
  const [duration, setDuration] = useState('any');
  const [order, setOrder] = useState('relevance');
  const [language, setLanguage] = useState('all');
  const [channelFilter, setChannelFilter] = useState('');
  const [activeCollection, setActiveCollection] = useState('search');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState('');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [isPlayerFloating, setIsPlayerFloating] = useState(false);
  const [storageError, setStorageError] = useState(watchLater.error);
  const searchRequestRef = useRef(null);
  const moreRequestRef = useRef(null);

  function updateQuery(value) {
    setQuery(value);
  }

  function closePlayer() {
    setSelectedVideo(null);
    setIsPlayerFloating(false);
  }

  useEffect(() => {
    return () => {
      searchRequestRef.current?.abort();
      moreRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectedVideo) return undefined;
    const previousOverflow = document.body.style.overflow;
    if (!isPlayerFloating) document.body.style.overflow = 'hidden';
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') closePlayer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      if (!isPlayerFloating) document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isPlayerFloating, selectedVideo]);

  async function runSearch(searchQuery = query) {
    const requestedQuery = searchQuery.normalize('NFKC').trim();
    searchRequestRef.current?.abort();
    moreRequestRef.current?.abort();
    setActiveCollection('search');
    setChannelFilter('');
    setIsLoadingMore(false);
    setError('');
    setVideos([]);
    setNextPageToken('');

    if (!requestedQuery) {
      setSubmittedQuery('');
      setHasSearched(false);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    searchRequestRef.current = controller;
    setQuery(requestedQuery);
    setSubmittedQuery(requestedQuery);
    setSubmittedDuration(duration);
    setSubmittedOrder(order);
    setSubmittedLanguage(language);
    setHasSearched(true);
    setIsLoading(true);
    try {
      const result = await searchYouTubeVideos(requestedQuery, '', {
        signal: controller.signal,
        duration,
        order,
        language
      });
      if (!controller.signal.aborted) {
        setVideos(result.videos);
        setNextPageToken(result.nextPageToken || '');
      }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError.message || 'YouTube search could not be completed.');
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
      if (searchRequestRef.current === controller) searchRequestRef.current = null;
    }
  }

  function submitSearch(event) {
    event.preventDefault();
    void runSearch();
  }

  function toggleWatchLater(video) {
    const isSaved = watchLater.videos.some((savedVideo) => savedVideo.videoId === video.videoId);
    const nextVideos = isSaved
      ? watchLater.videos.filter((savedVideo) => savedVideo.videoId !== video.videoId)
      : [video, ...watchLater.videos];
    try {
      localStorage.setItem(WATCH_LATER_KEY, JSON.stringify(nextVideos));
      setWatchLater({ videos: nextVideos, error: '' });
      setStorageError('');
    } catch {
      setStorageError('Watch Later could not be saved. Check this browser’s available storage.');
    }
  }

  async function loadMore() {
    if (!nextPageToken || isLoadingMore) return;
    const requestedQuery = submittedQuery;
    const controller = new AbortController();
    moreRequestRef.current = controller;
    setIsLoadingMore(true);
    setError('');
    try {
      const result = await searchYouTubeVideos(requestedQuery, nextPageToken, {
        signal: controller.signal,
        duration: submittedDuration,
        order: submittedOrder,
        language: submittedLanguage
      });
      if (!controller.signal.aborted && requestedQuery === query.normalize('NFKC').trim()) {
        setVideos((currentVideos) => {
          const knownIds = new Set(currentVideos.map((video) => video.videoId));
          return [...currentVideos, ...result.videos.filter((video) => !knownIds.has(video.videoId))];
        });
        setNextPageToken(result.nextPageToken || '');
      }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError.message || 'More videos could not be loaded.');
    } finally {
      if (!controller.signal.aborted) setIsLoadingMore(false);
    }
  }

  const sourceVideos = activeCollection === 'watch-later' ? watchLater.videos : videos;
  const channels = [...new Map(sourceVideos
    .filter((video) => video.channelId && video.channelName)
    .map((video) => [video.channelId, { id: video.channelId, name: video.channelName }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleVideos = sourceVideos.filter((video) => !channelFilter || video.channelId === channelFilter);
  const selectedVideoIndex = visibleVideos.findIndex((video) => video.videoId === selectedVideo?.videoId);
  const savedVideoIds = new Set(watchLater.videos.map((video) => video.videoId));

  return (
    <div className="yt-page">
      <header className="yt-header">
        <button type="button" className="yt-back-button" onClick={() => onNavigate('/')}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>Back to study portal</span>
        </button>
        <div className="yt-brand">
          <Play size={17} aria-hidden="true" />
          <span>Video Explorer</span>
        </div>
      </header>

      <main className="yt-main">
        <section className="yt-intro" aria-labelledby="yt-heading">
          <p className="yt-eyebrow">Learn something new</p>
          <h1 id="yt-heading">Explore YouTube</h1>
          <p className="yt-subtitle">Explore educational videos from YouTube and study at your own pace.</p>
          <form
            className="yt-search-form"
            role="search"
            onSubmit={submitSearch}
          >
            <label className="yt-visually-hidden" htmlFor="yt-search">Search YouTube videos</label>
            <Search size={20} aria-hidden="true" />
            <input
              id="yt-search"
              type="search"
              value={query}
              maxLength={100}
              autoComplete="off"
              placeholder="Search Telangana GK, polity, reasoning..."
              onChange={(event) => updateQuery(event.target.value)}
            />
            {query && (
              <button type="button" className="yt-clear-button" aria-label="Clear search" onClick={() => updateQuery('')}>
                <X size={17} aria-hidden="true" />
              </button>
            )}
            <button type="submit" className="yt-search-submit" aria-label="Search videos">
              <Search size={16} aria-hidden="true" />
              <span>Search</span>
            </button>
          </form>
          <div className="yt-search-options">
            <label>
              <span>Video length</span>
              <select aria-label="Video length" value={duration} onChange={(event) => setDuration(event.target.value)}>
                <option value="any">Any length</option>
                <option value="short">Under 4 minutes</option>
                <option value="medium">4–20 minutes</option>
                <option value="long">Over 20 minutes</option>
              </select>
            </label>
            <label>
              <span>Sort by</span>
              <select aria-label="Sort videos" value={order} onChange={(event) => setOrder(event.target.value)}>
                <option value="relevance">Most relevant</option>
                <option value="date">Newest</option>
                <option value="viewCount">Most viewed</option>
              </select>
            </label>
            <label>
              <span>Language</span>
              <select aria-label="Video language" value={language} onChange={(event) => setLanguage(event.target.value)}>
                <option value="all">All languages</option>
                <option value="te">Telugu</option>
                <option value="hi">Hindi</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>
          <p className="yt-search-hint">Search results are limited to YouTube’s Education category. Language is a YouTube relevance preference; filters apply when you search.</p>
          <div className="yt-related-searches" aria-label="Suggested study searches">
            <span>Popular study searches</span>
            {RELATED_SEARCHES.map((search) => (
              <button type="button" key={search} onClick={() => { void runSearch(search); }}>{search}</button>
            ))}
          </div>
        </section>

        <section className="yt-results" aria-live="polite" aria-busy={activeCollection === 'search' && (isLoading || isLoadingMore)}>
          <div className="yt-library-toolbar">
            <div className="yt-collection-tabs" role="group" aria-label="Video collection">
              <button type="button" aria-pressed={activeCollection === 'search'} onClick={() => { setActiveCollection('search'); setChannelFilter(''); }}>
                Search results
              </button>
              <button type="button" aria-pressed={activeCollection === 'watch-later'} onClick={() => { setActiveCollection('watch-later'); setChannelFilter(''); }}>
                <Bookmark size={15} aria-hidden="true" />
                Watch Later <span>{watchLater.videos.length}</span>
              </button>
            </div>
            {channels.length > 0 && (
              <label className="yt-channel-filter">
                <span>Channel</span>
                <select aria-label="Filter by channel" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}>
                  <option value="">All channels</option>
                  {channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {storageError && <p className="yt-storage-error" role="alert">{storageError}</p>}

          {activeCollection === 'search' && isLoading && (
            <div className="yt-video-grid" aria-label="Loading videos">
              {Array.from({ length: SKELETON_COUNT }, (_, index) => (
                <div className="yt-skeleton-card" key={index}>
                  <div className="yt-skeleton-thumbnail" />
                  <div className="yt-skeleton-line yt-skeleton-title" />
                  <div className="yt-skeleton-line" />
                  <div className="yt-skeleton-line yt-skeleton-short" />
                </div>
              ))}
            </div>
          )}

          {activeCollection === 'search' && !isLoading && error && (
            <div className="yt-state yt-error" role="alert">
              <h2>Search unavailable</h2>
              <p>{error}</p>
            </div>
          )}

          {activeCollection === 'search' && !isLoading && !error && !hasSearched && (
            <div className="yt-state">
              <div className="yt-state-icon"><Search size={24} aria-hidden="true" /></div>
              <h2>What would you like to watch?</h2>
              <p>Search for a topic, channel, or video to get started.</p>
            </div>
          )}

          {activeCollection === 'search' && !isLoading && !error && hasSearched && videos.length === 0 && (
            <div className="yt-state">
              <div className="yt-state-icon"><Play size={24} aria-hidden="true" /></div>
              <h2>No videos found</h2>
              <p>Try a different search phrase.</p>
            </div>
          )}

          {activeCollection === 'watch-later' && visibleVideos.length === 0 && (
            <div className="yt-state">
              <div className="yt-state-icon"><Bookmark size={24} aria-hidden="true" /></div>
              <h2>Your Watch Later list is empty</h2>
              <p>Save an educational video to find it here. This list is stored in this browser.</p>
            </div>
          )}

          {sourceVideos.length > 0 && visibleVideos.length === 0 && (
            <div className="yt-state">
              <div className="yt-state-icon"><Search size={24} aria-hidden="true" /></div>
              <h2>No videos from this channel</h2>
              <p>Choose another channel to see more videos.</p>
            </div>
          )}

          {visibleVideos.length > 0 && (
            <>
              <p className="yt-results-count">{visibleVideos.length} video{visibleVideos.length === 1 ? '' : 's'}{channelFilter ? ' from this channel' : ''}</p>
              <div className="yt-video-grid">
                {visibleVideos.map((video) => (
                  <article className="yt-video-card" key={video.videoId}>
                    <button
                      type="button"
                      className="yt-video-select"
                      onClick={() => setSelectedVideo(video)}
                      aria-label={`Play ${video.title} by ${video.channelName}`}
                    >
                      <span className="yt-thumbnail">
                        <img src={video.thumbnailUrl} alt="" loading="lazy" />
                        <span className="yt-play-overlay"><Play size={22} fill="currentColor" aria-hidden="true" /></span>
                      </span>
                      <span className="yt-video-copy">
                        <span className="yt-video-title">{video.title}</span>
                        <span className="yt-channel-name">{video.channelName}</span>
                        <span className="yt-video-duration"><Clock3 size={13} aria-hidden="true" />{formatVideoDuration(video.durationSeconds)}</span>
                        <span className="yt-video-description">{video.description || 'No description available.'}</span>
                        <span className="yt-published-date">{formatPublishedDate(video.publishedAt)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="yt-watch-later"
                      aria-pressed={savedVideoIds.has(video.videoId)}
                      onClick={() => toggleWatchLater(video)}
                    >
                      {savedVideoIds.has(video.videoId) ? <Check size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />}
                      {savedVideoIds.has(video.videoId) ? 'Saved for later' : 'Watch later'}
                    </button>
                  </article>
                ))}
              </div>
              {activeCollection === 'search' && nextPageToken && (
                <div className="yt-load-more-wrap">
                  <button type="button" className="yt-load-more" onClick={() => { void loadMore(); }} disabled={isLoadingMore}>
                    {isLoadingMore ? <LoaderCircle size={17} className="yt-spinner" aria-hidden="true" /> : null}
                    {isLoadingMore ? 'Loading videos...' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {selectedVideo && (
        <div className={`yt-player-layer${isPlayerFloating ? ' yt-player-layer--floating' : ''}`}>
          {!isPlayerFloating && (
            <button type="button" className="yt-player-backdrop" aria-label="Close video player" onClick={closePlayer} />
          )}
          <section className="yt-player-dialog" role="dialog" aria-modal={!isPlayerFloating} aria-labelledby="yt-player-title">
            <div className="yt-player-heading">
              <div>
                <h2 id="yt-player-title">{selectedVideo.title}</h2>
                <p>{selectedVideo.channelName}</p>
              </div>
              <button type="button" className="yt-close-player" aria-label="Close video player" onClick={closePlayer}>
                <X size={21} aria-hidden="true" />
              </button>
            </div>
            <div className="yt-player-controls" aria-label="Video playback navigation">
              <button
                type="button"
                className="yt-player-control"
                aria-label="Previous video"
                onClick={() => {
                  if (selectedVideoIndex > 0) setSelectedVideo(visibleVideos[selectedVideoIndex - 1]);
                }}
                disabled={selectedVideoIndex <= 0}
              >
                <ChevronLeft size={18} aria-hidden="true" />
                <span>Previous</span>
              </button>
              <button
                type="button"
                className="yt-player-control"
                aria-label="Next video"
                onClick={() => {
                  if (selectedVideoIndex >= 0 && selectedVideoIndex < visibleVideos.length - 1) {
                    setSelectedVideo(visibleVideos[selectedVideoIndex + 1]);
                  }
                }}
                disabled={selectedVideoIndex < 0 || selectedVideoIndex >= visibleVideos.length - 1}
              >
                <span>Next</span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="yt-player-control yt-player-float-toggle"
                aria-label={isPlayerFloating ? 'Dock video player' : 'Float video player'}
                aria-pressed={isPlayerFloating}
                onClick={() => setIsPlayerFloating((isFloating) => !isFloating)}
              >
                {isPlayerFloating ? <Minimize2 size={16} aria-hidden="true" /> : <PictureInPicture2 size={16} aria-hidden="true" />}
                <span>{isPlayerFloating ? 'Dock player' : 'Float player'}</span>
              </button>
            </div>
            <div className="yt-player-frame">
              <iframe
                key={selectedVideo.videoId}
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(selectedVideo.videoId)}?autoplay=1&rel=0`}
                title={`${selectedVideo.title} — YouTube video player`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
