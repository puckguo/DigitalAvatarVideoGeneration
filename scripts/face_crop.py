# 人脸近景裁剪框检测（供 LatentSync 输入预处理）
# 用法: python face_crop.py <视频路径> [insightface_root]
# 输出: W:H:X:Y 裁剪参数（stdout 单行）；无人脸输出 NOFACE（退出码 2）
# 说明: 用 LivePortrait 的 insightface buffalo_l 模型；在 LivePortrait 目录下运行（root 相对路径）。
#        裁剪策略: 人脸高的 2.6 倍正方形近景（含下巴/额头/少量肩部），中心偏下 55%。
import sys
import cv2


def main():
    video = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else 'pretrained_weights/insightface'
    cap = cv2.VideoCapture(video.replace('\\', '/'))
    if not cap.isOpened():
        print('NOFACE')
        return 2
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if n > 3:
        cap.set(cv2.CAP_PROP_POS_FRAMES, n // 2)  # 中间帧比首帧更稳（首帧常黑/糊）
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        print('NOFACE')
        return 2
    h, w = frame.shape[:2]
    try:
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name='buffalo_l', root=root, providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=-1, det_size=(512, 512))
        faces = app.get(frame)
    except Exception as e:
        sys.stderr.write(f'insightface error: {e}\n')
        print('NOFACE')
        return 2
    if not faces:
        print('NOFACE')
        return 2
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    x1, y1, x2, y2 = face.bbox
    bw, bh = x2 - x1, y2 - y1
    fh = int(bh * 2.6)
    fw = fh
    if fw > w:
        fw = w
        fh = fw
    cx, cy = int((x1 + x2) / 2), int(y1 + bh * 0.55)
    X = max(0, min(w - fw, cx - fw // 2))
    Y = max(0, min(h - fh, cy - fh // 2))
    fw, fh = min(fw, w - X), min(fh, h - Y)
    if fw < 100 or fh < 100:
        print('NOFACE')
        return 2
    print(f'{fw}:{fh}:{X}:{Y}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
