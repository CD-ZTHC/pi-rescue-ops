// 图片放大查看：点击工具卡片里的缩略图打开，像素风图片用 pixelated 放大。
import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';

export const useLightbox = create<{ src?: string; caption?: string }>(() => ({}));

export function Lightbox() {
  const { src, caption } = useLightbox();
  return (
    <AnimatePresence>
      {src && (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/75 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => useLightbox.setState({ src: undefined })}
        >
          <motion.img
            src={src}
            alt={caption ?? ''}
            className="w-[min(90vw,960px)] rounded-lg border border-cyan-400/30 shadow-2xl"
            style={{ imageRendering: 'pixelated' }}
            initial={{ scale: 0.92 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
          />
          {caption && <div className="text-[13px] text-slate-300">{caption}</div>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
