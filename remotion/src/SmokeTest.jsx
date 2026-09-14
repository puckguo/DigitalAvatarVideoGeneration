import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

/** 安装自检合成：渲染 30 帧静态画面 */
export const SmokeTest = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #1a1a2e 0%, #ff2e4d 100%)',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{ color: '#fff', fontSize: 42, fontWeight: 800 }}>
        Remotion OK · frame {frame}
      </div>
    </AbsoluteFill>
  );
};
