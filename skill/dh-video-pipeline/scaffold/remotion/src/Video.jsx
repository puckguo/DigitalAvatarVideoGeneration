import React from 'react';
import {
  AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing,
} from 'remotion';

const ACCENT = '#ff2e4d';

/**
 * 数字人合成画面：HeyGen 原始视频 + 标题栏 + 底部字幕 + 水印 + 进度条
 * props: { videoFile, cues[{start,end,text}], title, showTitleBar, showProgressBar, watermark }
 */
export const DigitalHuman = ({ videoFile, cues, title, showTitleBar, showProgressBar, watermark }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const t = frame / fps;

  const cue = (cues || []).find((c) => t >= c.start && t <= c.end) || null;

  const titleIn = showTitleBar && title
    ? interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
    : 0;

  const cueIn = cue
    ? interpolate(t, [cue.start, cue.start + 0.18], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' })
    : 0;

  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <OffthreadVideo
        src={staticFile(videoFile || 'video.mp4')}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />

      {/* 顶部标题栏 */}
      {showTitleBar && title ? (
        <div
          style={{
            position: 'absolute', top: Math.round(height * 0.045), left: 0, right: 0,
            display: 'flex', justifyContent: 'center',
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * -18}px)`,
          }}
        >
          <div
            style={{
              background: 'rgba(0,0,0,0.45)',
              color: '#fff',
              fontSize: Math.round(width * 0.036),
              fontWeight: 700,
              padding: `${Math.round(height * 0.011)}px ${Math.round(width * 0.05)}px`,
              borderRadius: 999,
              maxWidth: '88%',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </div>
        </div>
      ) : null}

      {/* 底部字幕 */}
      {cue ? (
        <div
          style={{
            position: 'absolute', left: 0, right: 0, bottom: Math.round(height * 0.1),
            display: 'flex', justifyContent: 'center',
            padding: `0 ${Math.round(width * 0.05)}px`,
            opacity: cueIn,
          }}
        >
          <div
            style={{
              background: 'rgba(0,0,0,0.55)',
              color: '#fff',
              fontSize: Math.round(width * 0.044),
              lineHeight: 1.5,
              fontWeight: 600,
              textAlign: 'center',
              borderRadius: Math.round(width * 0.014),
              padding: `${Math.round(height * 0.011)}px ${Math.round(width * 0.045)}px`,
              maxWidth: '94%',
              whiteSpace: 'pre-line',
              textShadow: '0 1px 2px rgba(0,0,0,0.6)',
            }}
          >
            {cue.text}
          </div>
        </div>
      ) : null}

      {/* 右下角水印 */}
      {watermark ? (
        <div
          style={{
            position: 'absolute',
            right: Math.round(width * 0.04),
            bottom: Math.round(height * 0.032),
            color: 'rgba(255,255,255,0.78)',
            fontSize: Math.round(width * 0.026),
            fontWeight: 600,
            textShadow: '0 1px 2px rgba(0,0,0,0.5)',
          }}
        >
          {watermark}
        </div>
      ) : null}

      {/* 底部进度条 */}
      {showProgressBar ? (
        <div
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            height: Math.max(4, Math.round(height * 0.0035)),
            background: 'rgba(255,255,255,0.18)',
          }}
        >
          <div style={{ height: '100%', width: `${progress * 100}%`, background: ACCENT }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
