import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LoaderCircle, Play, Search, X } from 'lucide-react';
import { searchYouTubeVideos } from './services/aiService.js';
import './YouTubeExplorer.css';

const SKELETON_COUNT = 6;

function formatPublishedDate(value) {
  if (!value) return 'Publication date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Publication date unavailable';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export default function YouTubeExplorer({ onNavigate }) {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState([]);
  const [nextPageToken, setNextPageToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState('');
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [searchTrigger, setSearchTrigger] = useState(0);
  const moreRequestRef = useRef(null);
  const runSearchImmediatelyRef = useRef(false);

  function updateQuery(value) {
    const hasQuery = Boolean(value.normalize('NFKC').trim());
    moreRequestRef.current?.abort();
    setQuery(value);
    setVideos([]);
    setNextPageToken('');
    setError('');
    setHasSearched(hasQuery);
    setIsLoading(hasQuery);
    setIsLoadingMore(false);
  }

  useEffect(() => {
    const normalizedQuery = query.normalize('NFKC').trim();
    moreRequestRef.current?.abort();
    const searchImmediately = runSearchImmediatelyRef.current;
    runSearchImmediatelyRef.current = false;

    if (!normalizedQuery) return undefined;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const result = await searchYouTubeVideos(normalizedQuery, '', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setVideos(result.videos);
          setNextPageToken(result.nextPageToken || '');
        }
      } catch (requestError) {
        if (!controller.signal.aborted) setError(requestError.message || 'YouTube search could not be completed.');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, searchImmediately ? 0 : 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      moreRequestRef.current?.abort();
    };
  }, [query, searchTrigger]);

  useEffect(() => {
    if (!selectedVideo) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSelectedVideo(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [selectedVideo]);

  async function loadMore() {
    if (!nextPageToken || isLoadingMore) return;
    const requestedQuery = query.normalize('NFKC').trim();
    const controller = new AbortController();
    moreRequestRef.current = controller;
    setIsLoadingMore(true);
    setError('');
    try {
      const result = await searchYouTubeVideos(requestedQuery, nextPageToken, { signal: controller.signal });
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
          <p className="yt-subtitle">Search videos from across YouTube and watch them right here.</p>
          <form
            className="yt-search-form"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              runSearchImmediatelyRef.current = true;
              setSearchTrigger((current) => current + 1);
            }}
          >
            <label className="yt-visually-hidden" htmlFor="yt-search">Search YouTube videos</label>
            <Search size={20} aria-hidden="true" />
            <input
              id="yt-search"
              type="search"
              value={query}
              maxLength={100}
              autoComplete="off"
              placeholder="Search programming, science, music..."
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
          <p className="yt-search-hint">Results are shown here. Select a video to play it without leaving this page.</p>
        </section>

        <section className="yt-results" aria-live="polite" aria-busy={isLoading || isLoadingMore}>
          {isLoading && (
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

          {!isLoading && error && (
            <div className="yt-state yt-error" role="alert">
              <h2>Search unavailable</h2>
              <p>{error}</p>
            </div>
          )}

          {!isLoading && !error && !hasSearched && (
            <div className="yt-state">
              <div className="yt-state-icon"><Search size={24} aria-hidden="true" /></div>
              <h2>What would you like to watch?</h2>
              <p>Search for a topic, channel, or video to get started.</p>
            </div>
          )}

          {!isLoading && !error && hasSearched && videos.length === 0 && (
            <div className="yt-state">
              <div className="yt-state-icon"><Play size={24} aria-hidden="true" /></div>
              <h2>No videos found</h2>
              <p>Try a different search phrase.</p>
            </div>
          )}

          {!isLoading && videos.length > 0 && (
            <>
              <div className="yt-video-grid">
                {videos.map((video) => (
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
                        <span className="yt-video-description">{video.description || 'No description available.'}</span>
                        <span className="yt-published-date">{formatPublishedDate(video.publishedAt)}</span>
                      </span>
                    </button>
                  </article>
                ))}
              </div>
              {nextPageToken && (
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
        <div className="yt-player-layer">
          <button type="button" className="yt-player-backdrop" aria-label="Close video player" onClick={() => setSelectedVideo(null)} />
          <section className="yt-player-dialog" role="dialog" aria-modal="true" aria-labelledby="yt-player-title">
            <div className="yt-player-heading">
              <div>
                <h2 id="yt-player-title">{selectedVideo.title}</h2>
                <p>{selectedVideo.channelName}</p>
              </div>
              <button type="button" className="yt-close-player" aria-label="Close video player" onClick={() => setSelectedVideo(null)}>
                <X size={21} aria-hidden="true" />
              </button>
            </div>
            <div className="yt-player-frame">
              <iframe
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
