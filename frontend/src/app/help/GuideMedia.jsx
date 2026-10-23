import { useEffect, useId, useRef, useState } from 'react';
import { parseVideoUrl } from './frontmatter.js';
import styles from './GuideMedia.module.css';

export const IMAGE_BASE = '/help/images/';

/** Adds autoplay for the player that is only created after the reader pressed play. */
function playerSrc(video) {
  if (video.kind === 'file') return video.src;
  const url = new URL(video.src);
  url.searchParams.set('autoplay', '1');
  return url.toString();
}

function Video({ url, title }) {
  const video = parseVideoUrl(url);
  const [playing, setPlaying] = useState(false);
  if (!video) return null;
  const label = title || 'Guide video';

  return (
    <figure className={styles.video}>
      <div className={styles.frame}>
        {!playing ? (
          <button type="button" className={styles.play} onClick={() => setPlaying(true)}>
            <span className={styles.playIcon} aria-hidden="true">▶</span>
            <span>Play video: {label}</span>
            <span className={styles.privacy}>Nothing is loaded from {video.provider} until you press play.</span>
          </button>
        ) : video.kind === 'file' ? (
          <video className={styles.player} src={playerSrc(video)} title={label} controls autoPlay preload="none" />
        ) : (
          <iframe
            className={styles.player}
            src={playerSrc(video)}
            title={label}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
    </figure>
  );
}

function ZoomDialog({ image, onClose }) {
  const closeRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={onClose}>
      <div className={styles.zoomBody} onClick={(event) => event.stopPropagation()}>
        <img className={styles.zoomImage} src={`${IMAGE_BASE}${image.file}`} alt={image.alt} />
        <p id={titleId} className={styles.zoomCaption}>{image.caption || image.alt}</p>
        <button ref={closeRef} type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Pictures and video for a guide. The numbered steps stay in the guide's text
 * beside this; media only illustrates them.
 *  - Images load lazily and open larger on click (Escape or Close to leave).
 *  - A video is a plain button until pressed: no request goes to the video
 *    host, and no cookie is set, before that.
 * Front matter has already been validated (see `frontmatter.js`).
 */
export function GuideMedia({ video, videoTitle, images = [] }) {
  const [zoomed, setZoomed] = useState(null);
  const [failed, setFailed] = useState(() => new Set());
  const shown = images.filter((image) => !failed.has(image.file));
  const playable = video && parseVideoUrl(video);
  if (!playable && shown.length === 0) return null;

  return (
    <aside className={styles.media} aria-label="Pictures and video for this guide">
      {playable && <Video url={video} title={videoTitle} />}
      {shown.map((image) => (
        <figure key={image.file} className={styles.figure}>
          <button type="button" className={styles.thumb} onClick={() => setZoomed(image)} aria-label={`Enlarge: ${image.alt}`}>
            <img
              src={`${IMAGE_BASE}${image.file}`}
              alt={image.alt}
              loading="lazy"
              decoding="async"
              // A picture that has not been captured yet is simply left out.
              onError={() => setFailed((current) => new Set(current).add(image.file))}
            />
          </button>
          {image.caption && <figcaption>{image.caption}</figcaption>}
        </figure>
      ))}
      {zoomed && <ZoomDialog image={zoomed} onClose={() => setZoomed(null)} />}
    </aside>
  );
}
