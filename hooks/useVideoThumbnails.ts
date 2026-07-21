'use client'

import { useEffect, useState, useRef } from 'react'

// Lightweight client-side frame extractor. Takes a video URL and a list of
// timecodes (seconds) and returns a map of timecode -> dataURL for a small
// thumbnail image. Uses an offscreen <video> + <canvas>; nothing is uploaded.
// CORS: the video URL must allow cross-origin reads (R2 objects served with
// permissive headers already do).

export interface UseVideoThumbnailsOptions {
  videoUrl: string | null | undefined
  timecodes: number[]
  thumbWidth?: number
}

export function useVideoThumbnails({ videoUrl, timecodes, thumbWidth = 160 }: UseVideoThumbnailsOptions) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const cacheRef = useRef<Record<string, Record<number, string>>>({})

  useEffect(() => {
    if (!videoUrl || !timecodes.length) {
      setThumbs({})
      return
    }

    const cached = cacheRef.current[videoUrl] ?? {}
    const missing = timecodes.filter((t) => !(t in cached))
    if (!missing.length) {
      setThumbs(cached)
      return
    }

    let canceled = false
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'
    video.muted = true
    video.src = videoUrl
    video.playsInline = true

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')

    const captureOne = (t: number): Promise<void> => {
      return new Promise((resolve) => {
        const onSeeked = () => {
          if (canceled || !ctx) {
            video.removeEventListener('seeked', onSeeked)
            resolve()
            return
          }
          try {
            const aspect = video.videoHeight / Math.max(video.videoWidth, 1)
            const w = thumbWidth
            const h = Math.max(1, Math.round(w * aspect))
            canvas.width = w
            canvas.height = h
            ctx.drawImage(video, 0, 0, w, h)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
            cached[t] = dataUrl
          } catch {
            /* ignore individual failures (CORS, codec, etc.) */
          }
          video.removeEventListener('seeked', onSeeked)
          resolve()
        }
        video.addEventListener('seeked', onSeeked, { once: true })
        try {
          video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.05))
        } catch {
          video.removeEventListener('seeked', onSeeked)
          resolve()
        }
      })
    }

    const captureAll = async () => {
      for (const t of missing) {
        if (canceled) return
        await captureOne(t)
        if (canceled) return
        cacheRef.current[videoUrl] = { ...cached }
        if (!canceled) setThumbs({ ...cacheRef.current[videoUrl] })
      }
    }

    const onLoadedMeta = () => {
      if (!canceled) captureAll()
    }
    video.addEventListener('loadedmetadata', onLoadedMeta, { once: true })

    if (Object.keys(cached).length > 0) setThumbs({ ...cached })

    return () => {
      canceled = true
      video.removeEventListener('loadedmetadata', onLoadedMeta)
      try {
        video.src = ''
        video.load()
      } catch {
        /* ignore */
      }
    }
  }, [videoUrl, timecodes.join(','), thumbWidth])

  return thumbs
}
