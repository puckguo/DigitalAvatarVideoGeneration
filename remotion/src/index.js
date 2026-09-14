const React = require('react');
const { registerRoot, Composition } = require('remotion');
const { DigitalHuman } = require('./Video');
const { SmokeTest } = require('./SmokeTest');

// Remotion 要求 Composition 组件可转发 ref
const DigitalHumanWithRef = React.forwardRef((props, ref) =>
  React.createElement(DigitalHuman, { ...props, ref })
);
const SmokeTestWithRef = React.forwardRef((props, ref) =>
  React.createElement(SmokeTest, { ...props, ref })
);

registerRoot(() =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement(Composition, {
      id: 'DigitalHuman',
      component: DigitalHumanWithRef,
      durationInFrames: 150,
      fps: 30,
      width: 1080,
      height: 1920,
      defaultProps: {
        videoFile: 'video.mp4',
        cues: [],
        title: '',
        showTitleBar: true,
        showProgressBar: true,
        watermark: '',
        fps: 30,
        durationSeconds: 5,
        width: 1080,
        height: 1920,
      },
      // 分辨率/时长由 props 动态决定
      calculateMetadata: ({ props }) => ({
        width: props.width || 1080,
        height: props.height || 1920,
        fps: props.fps || 30,
        durationInFrames: Math.max(1, Math.ceil((props.durationSeconds || 5) * (props.fps || 30)) + 6),
      }),
    }),
    React.createElement(Composition, {
      id: 'SmokeTest',
      component: SmokeTestWithRef,
      durationInFrames: 30,
      fps: 30,
      width: 640,
      height: 360,
      defaultProps: {},
    })
  )
);
