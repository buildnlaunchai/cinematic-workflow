'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVideoThumbnails } from '@/hooks/useVideoThumbnails'
import type { SharedWorkflowPayload, SharedComment } from '@/types'
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  MessageSquare, Loader2, Video, Film, Lock,
  Clock, Paperclip, ExternalLink, ChevronDown, ChevronRight, Search, X,
  Minus, Plus, Maximize2,
} from 'lucide-react'

// Schema `cinematic_workflow` is pinned inside createClient(); one module-level client.
const supabase = createClient()

// A guest node as returned by the RPC payload (no owner/internal ids).
type ShareNode = SharedWorkflowPayload['nodes'][number]

// HH;MM;SS;FF timecode at 30fps — Premiere Pro drop-frame format, pastes to exact frame.
function formatTimecode(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '00;00;00;00'
  const hrs    = Math.floor(seconds / 3600)
  const mins   = Math.floor((seconds % 3600) / 60)
  const secs   = Math.floor(seconds % 60)
  const frames = Math.floor((seconds % 1) * 30)
  return `${String(hrs).padStart(2,'0')};${String(mins).padStart(2,'0')};${String(secs).padStart(2,'0')};${String(frames).padStart(2,'0')}`
}

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export function ShareViewer({ token }: { token: string }) {
  const [status, setStatus] = useState<'loading' | 'invalid' | 'ready'>('loading')
  const [resourceTitle, setResourceTitle] = useState('')
  const [nodes, setNodes] = useState<ShareNode[]>([])
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [comments, setComments] = useState<SharedComment[]>([])

  const videoRef = useRef<HTMLVideoElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [timecodeCopied, setTimecodeCopied] = useState(false)

  const [visibleAnnotationId, setVisibleAnnotationId] = useState<string | null>(null)
  const [expandedCommentIds, setExpandedCommentIds] = useState<Set<string>>(new Set())
  const [commentSearch, setCommentSearch] = useState('')
  const [floatingHidden, setFloatingHidden] = useState(false)

  const activeNode = useMemo(() => nodes.find(n => n.id === activeNodeId), [nodes, activeNodeId])
  const activeComments = useMemo(
    () => comments.filter(c => c.node_id === activeNodeId && !c.parent_id),
    [comments, activeNodeId]
  )
  const repliesByParent = useMemo(() => {
    const map: Record<string, SharedComment[]> = {}
    comments.filter(c => c.parent_id).forEach(c => {
      if (!map[c.parent_id!]) map[c.parent_id!] = []
      map[c.parent_id!].push(c)
    })
    return map
  }, [comments])

  const filteredComments = useMemo(() => {
    const q = commentSearch.trim().toLowerCase()
    if (!q) return activeComments
    return activeComments.filter(c => {
      if ((c.content || '').toLowerCase().includes(q)) return true
      if ((c.author_name || '').toLowerCase().includes(q)) return true
      return (repliesByParent[c.id] || []).some(r =>
        (r.content || '').toLowerCase().includes(q) ||
        (r.author_name || '').toLowerCase().includes(q)
      )
    })
  }, [activeComments, commentSearch, repliesByParent])

  const commentMarkers = useMemo(
    () => Array.from(new Set(activeComments.map(c => Math.max(0, Math.floor(c.timestamp_seconds ?? 0))))),
    [activeComments]
  )

  // Frame thumbnails for each comment's timestamp (matches the editor view).
  const commentTimecodes = useMemo(
    () => Array.from(new Set(activeComments.map(c => Math.max(0, Math.floor(c.timestamp_seconds ?? 0))))),
    [activeComments]
  )
  const commentThumbs = useVideoThumbnails({ videoUrl: activeNode?.video_url, timecodes: commentTimecodes })

  // Only one annotation is shown at a time: the one the playhead is on, or the
  // one the viewer explicitly clicked in the sidebar.
  const visibleAnnotation = useMemo(() => {
    if (visibleAnnotationId) {
      const sel = activeComments.find(c => c.id === visibleAnnotationId)
      if (sel?.annotation) return sel
    }
    for (const c of activeComments) {
      if (c.annotation && c.timestamp_seconds != null &&
          currentTime >= c.timestamp_seconds - 0.5 && currentTime <= c.timestamp_seconds + 1.0) {
        return c
      }
    }
    return null
  }, [activeComments, currentTime, visibleAnnotationId])

  useEffect(() => { setFloatingHidden(false) }, [visibleAnnotation?.id])

  // Single public RPC call — replaces the ERP's four anon table reads. The guest
  // function returns { workflow, nodes, comments } (or a null workflow when the
  // token is invalid/expired) and never exposes internal ids.
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('get_shared_workflow', { share_token: token })
      const payload = data as SharedWorkflowPayload | null

      if (error || !payload || !payload.workflow) {
        setStatus('invalid')
        return
      }

      // Real workflow title (empty → generic fallback). The ERP always showed the
      // generic label; the payload gives us the actual title.
      setResourceTitle(payload.workflow.title || 'Cinematic Workflow')

      const nodeList: ShareNode[] = payload.nodes ?? []
      setNodes(nodeList)
      if (nodeList.length) setActiveNodeId(nodeList[0].id)

      setComments(payload.comments ?? [])
      setStatus('ready')
    })()
  }, [token])

  // Reset video state when node changes
  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setVisibleAnnotationId(null)
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }, [activeNodeId])

  const togglePlay = () => {
    if (!videoRef.current) return
    if (isPlaying) videoRef.current.pause(); else videoRef.current.play()
  }

  const seek = (t: number) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = t
    setCurrentTime(t)
  }

  const stepRate = (dir: 1 | -1) => {
    setPlaybackRate(prev => {
      const i = SPEED_STEPS.indexOf(prev)
      const next = i + dir
      return next >= 0 && next < SPEED_STEPS.length ? SPEED_STEPS[next] : prev
    })
  }

  const copyTimecode = async () => {
    const tc = formatTimecode(currentTime)
    try {
      await navigator.clipboard.writeText(tc)
    } catch {
      const el = document.createElement('textarea')
      el.value = tc
      el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(el)
      el.focus(); el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    setTimecodeCopied(true)
    setTimeout(() => setTimecodeCopied(false), 1500)
  }

  const toggleFullscreen = () => {
    const el = videoAreaRef.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }

  // Apply playback speed to the video element.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate
  }, [playbackRate, activeNodeId])

  // Keyboard shortcuts — mirror the editor (space, ←/→ frame step, ↑/↓ speed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const video = videoRef.current
      if (!video) return
      const frameTime = 1 / 30
      const jumpTime = 5
      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
          e.preventDefault()
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + (e.shiftKey ? jumpTime : frameTime))
          setCurrentTime(video.currentTime)
          break
        case 'ArrowLeft':
          e.preventDefault()
          video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? jumpTime : frameTime))
          setCurrentTime(video.currentTime)
          break
        case 'l': case 'L': case 'ArrowUp':
          e.preventDefault()
          stepRate(1)
          break
        case 'k': case 'K': case 'ArrowDown':
          e.preventDefault()
          stepRate(-1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPlaying])

  const handleCommentClick = (c: SharedComment) => {
    if (c.node_id !== activeNodeId) {
      setActiveNodeId(c.node_id)
      setTimeout(() => {
        if (videoRef.current && c.timestamp_seconds != null) {
          videoRef.current.currentTime = c.timestamp_seconds
          setCurrentTime(c.timestamp_seconds)
        }
        setVisibleAnnotationId(c.id)
      }, 100)
      return
    }
    if (c.timestamp_seconds != null) seek(c.timestamp_seconds)
    setVisibleAnnotationId(prev => prev === c.id ? null : c.id)
  }

  if (status === 'loading') {
    return (
      <div className="h-screen w-screen bg-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 size={36} className="animate-spin text-sky-400" />
          <p className="text-slate-400 text-sm font-medium">Loading shared workspace…</p>
        </div>
      </div>
    )
  }

  if (status === 'invalid') {
    return (
      <div className="h-screen w-screen bg-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
            <Lock size={28} className="text-slate-400" />
          </div>
          <h2 className="text-white text-xl font-bold">Link unavailable</h2>
          <p className="text-slate-400 text-sm">This share link is invalid or has been revoked by the owner.</p>
        </div>
      </div>
    )
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="dark h-screen w-screen bg-slate-950 flex flex-col overflow-hidden font-sans text-slate-200">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-3 min-w-0">
          <Film size={22} className="text-sky-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Cinematic Workflow · Shared</p>
            <h1 className="text-sm font-semibold text-white truncate">{resourceTitle}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full">
            <Lock size={10} /> Read Only
          </span>
        </div>
      </div>

      {/* Node tabs */}
      {nodes.length > 1 && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-800 bg-slate-900/40 overflow-x-auto scrollbar-hide">
          {nodes.map((n, i) => (
            <button
              key={n.id}
              onClick={() => setActiveNodeId(n.id)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors ${
                n.id === activeNodeId
                  ? 'bg-sky-500 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              Version {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Video panel */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-black">
          {!activeNode ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Video size={40} className="text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">No video in this workspace.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Video area */}
              <div ref={videoAreaRef} className="flex-1 relative overflow-hidden min-h-0 bg-black">
                <video
                  ref={videoRef}
                  src={activeNode.video_url}
                  className="absolute inset-0 w-full h-full object-contain"
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                  onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
                  onEnded={() => setIsPlaying(false)}
                  onVolumeChange={() => {
                    if (videoRef.current) {
                      setIsMuted(videoRef.current.muted)
                      setVolume(videoRef.current.volume)
                    }
                  }}
                />
                {/* Annotation overlay — only the active annotation is shown */}
                {visibleAnnotation?.annotation && (() => {
                  const ann = visibleAnnotation.annotation!
                  // annotation.rect is stored as two corners in {x1,y1,x2,y2}
                  // percentages — the same shape the workspace writes.
                  const rect = ann.rect
                  const rx1 = rect ? rect.x1 : 0
                  const ry1 = rect ? rect.y1 : 0
                  const rx2 = rect ? rect.x2 : 0
                  const ry2 = rect ? rect.y2 : 0
                  const anchorX = rect ? (rx1 + rx2) / 2 : ann.x
                  const anchorY = rect ? ry2 : ann.y
                  const pos = {
                    x: Math.min(70, anchorX + 6),
                    y: Math.max(2, (rect ? Math.min(ry1, ry2) : ann.y) - 18),
                  }
                  const name = visibleAnnotation.author_name || 'Reviewer'
                  const avatar = visibleAnnotation.author_avatar
                  return (
                    <div className="absolute inset-0 pointer-events-none">
                      {/* Shape */}
                      {rect ? (
                        <div
                          className="absolute border-2 border-orange-500 bg-orange-500/10 z-10"
                          style={{
                            left: `${Math.min(rx1, rx2)}%`,
                            top: `${Math.min(ry1, ry2)}%`,
                            width: `${Math.abs(rx2 - rx1)}%`,
                            height: `${Math.abs(ry2 - ry1)}%`,
                          }}
                        >
                          <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-500" />
                          <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-500" />
                          <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-500" />
                          <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-500" />
                        </div>
                      ) : (
                        <div
                          className="absolute w-8 h-8 -ml-4 -mt-4 bg-orange-500 rounded-full border-4 border-white shadow-xl z-10 flex items-center justify-center"
                          style={{ left: `${ann.x}%`, top: `${ann.y}%` }}
                        >
                          <span className="w-2 h-2 bg-white rounded-full" />
                        </div>
                      )}

                      {/* Floating comment popup with connector line */}
                      {!floatingHidden && (
                        <>
                          <svg className="absolute inset-0 w-full h-full z-20" preserveAspectRatio="none">
                            <line
                              x1={`${anchorX}%`} y1={`${anchorY}%`}
                              x2={`${pos.x + 3}%`} y2={`${pos.y + 4}%`}
                              stroke="#fb923c" strokeWidth="2" strokeLinecap="round"
                            />
                          </svg>
                          <div
                            className="absolute z-30 bg-slate-900/95 backdrop-blur-sm border border-slate-700 rounded-lg shadow-2xl w-72 pointer-events-auto"
                            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                          >
                            <div className="flex items-center justify-between gap-2 p-2.5">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-6 h-6 rounded-full bg-orange-500 flex items-center justify-center overflow-hidden shrink-0">
                                  {avatar ? <img src={avatar} className="w-full h-full object-cover" /> : <span className="text-[10px] font-bold text-white">{getInitials(name)}</span>}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-white truncate leading-tight">{name}</p>
                                  <p className="text-[10px] text-slate-400">{new Date(visibleAnnotation.created_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</p>
                                </div>
                              </div>
                              <button onClick={() => setFloatingHidden(true)} className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 shrink-0" title="Close">
                                <X size={14} />
                              </button>
                            </div>
                            {visibleAnnotation.content && (
                              <div className="px-3 pb-2.5">
                                <p className="text-sm text-slate-100 leading-snug break-words">{visibleAnnotation.content}</p>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()}
              </div>

              {/* Controls */}
              <div className="shrink-0 px-4 py-3 bg-slate-950/95 backdrop-blur-sm border-t border-slate-800">
                {/* Timeline */}
                <div className="relative mb-3 h-1.5 bg-slate-700 rounded-full cursor-pointer group" onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  seek(((e.clientX - rect.left) / rect.width) * duration)
                }}>
                  <div className="h-full bg-sky-500 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
                  {/* Comment markers */}
                  {commentMarkers.map(t => (
                    <div
                      key={t}
                      className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-orange-400 border border-slate-900 pointer-events-none"
                      style={{ left: `${duration > 0 ? (t / duration) * 100 : 0}%`, transform: 'translate(-50%, -50%)' }}
                    />
                  ))}
                  <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white border-2 border-sky-500 shadow opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" style={{ left: `${progressPct}%`, transform: 'translate(-50%, -50%)' }} />
                </div>

                <div className="flex items-center gap-3">
                  <button onClick={() => seek(Math.max(0, currentTime - 5))} className="text-slate-400 hover:text-white transition-colors">
                    <SkipBack size={16} />
                  </button>
                  <button
                    onClick={togglePlay}
                    className="w-8 h-8 rounded-full bg-sky-500 flex items-center justify-center text-white hover:brightness-110 transition-all"
                  >
                    {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
                  </button>
                  <button onClick={() => seek(Math.min(duration, currentTime + 5))} className="text-slate-400 hover:text-white transition-colors">
                    <SkipForward size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={copyTimecode}
                    title="Click to copy timecode (MM:SS:FF)"
                    className={`text-xs font-bold tabular-nums ml-1 px-1.5 py-0.5 rounded transition-all ${timecodeCopied ? 'bg-emerald-500 text-white' : 'text-slate-300 hover:text-white hover:bg-white/10'}`}
                  >
                    {timecodeCopied ? '✓ COPIED' : formatTimecode(currentTime)}
                  </button>
                  <span className="text-xs font-bold tabular-nums text-slate-500"><span className="opacity-50 mx-1">/</span>{formatTimecode(duration)}</span>
                  <div className="ml-auto flex items-center gap-3">
                    {/* Playback speed */}
                    <div className="flex items-center bg-slate-800 border border-slate-700 rounded-md overflow-hidden">
                      <button
                        onClick={() => stepRate(-1)}
                        disabled={playbackRate <= SPEED_STEPS[0]}
                        className="px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-30"
                        title="Slow down (↓ / K)"
                      >
                        <Minus size={13} />
                      </button>
                      <span className="text-xs font-bold tabular-nums text-slate-200 w-12 text-center select-none">{playbackRate}x</span>
                      <button
                        onClick={() => stepRate(1)}
                        disabled={playbackRate >= SPEED_STEPS[SPEED_STEPS.length - 1]}
                        className="px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-30"
                        title="Speed up (↑ / L)"
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.muted = !videoRef.current.muted
                          setIsMuted(!isMuted)
                        }
                      }}
                      className="text-slate-400 hover:text-white transition-colors"
                    >
                      {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <input
                      type="range" min="0" max="1" step="0.05" value={isMuted ? 0 : volume}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setVolume(v)
                        if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0 }
                      }}
                      className="w-16 accent-sky-500"
                    />
                    <button onClick={toggleFullscreen} className="text-slate-400 hover:text-white transition-colors" title="Fullscreen">
                      <Maximize2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Comment sidebar */}
        <div className="w-80 shrink-0 flex flex-col border-l border-slate-800 bg-slate-900 overflow-hidden">
          <div className="shrink-0 px-4 py-3 border-b border-slate-800 space-y-2.5">
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-slate-400" />
              <span className="text-xs font-black uppercase tracking-widest text-slate-400">
                Comments {activeComments.length > 0 && `(${activeComments.length})`}
              </span>
            </div>
            {activeComments.length > 0 && (
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  type="text"
                  value={commentSearch}
                  onChange={e => setCommentSearch(e.target.value)}
                  placeholder="Search comments"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none focus:border-sky-500"
                />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-hide">
            {activeComments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
                <MessageSquare size={28} className="text-slate-700" />
                <p className="text-slate-500 text-xs font-medium">No comments on this version yet.</p>
              </div>
            ) : filteredComments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
                <Search size={28} className="text-slate-700" />
                <p className="text-slate-500 text-xs font-medium">No comments match your search.</p>
              </div>
            ) : (
              <div className="p-3 space-y-2">
                {filteredComments.map(c => {
                  const isActive = visibleAnnotation?.id === c.id
                  const replies = repliesByParent[c.id] || []
                  const isExpanded = expandedCommentIds.has(c.id)
                  const name = c.author_name || 'Reviewer'
                  const avatar = c.author_avatar
                  const thumb = commentThumbs[Math.max(0, Math.floor(c.timestamp_seconds ?? 0))]
                  return (
                    <div
                      key={c.id}
                      className={`rounded-xl border transition-all cursor-pointer ${
                        isActive
                          ? 'border-orange-500/50 bg-orange-500/5'
                          : 'border-slate-800 bg-slate-800/40 hover:border-slate-700'
                      }`}
                      onClick={() => handleCommentClick(c)}
                    >
                      <div className="p-3">
                        <div className="flex items-start gap-2">
                          {/* Avatar */}
                          <div className="w-7 h-7 rounded-full shrink-0 overflow-hidden bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-300">
                            {avatar ? (
                              <img src={avatar} alt="" className="w-full h-full object-cover" />
                            ) : (
                              getInitials(name)
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-[11px] font-bold text-slate-200 truncate">{name}</span>
                              {c.timestamp_seconds != null && (
                                <span className="flex items-center gap-0.5 text-[10px] font-mono text-sky-400 shrink-0">
                                  <Clock size={9} /> {formatTimecode(c.timestamp_seconds)}
                                </span>
                              )}
                              {c.annotation && (
                                <span className="text-[9px] font-bold text-orange-400 uppercase tracking-wide shrink-0 ml-auto">Marker</span>
                              )}
                            </div>
                            <div className="flex items-start gap-2 mt-1">
                              {thumb ? (
                                <div className="relative w-16 h-10 rounded-md overflow-hidden border border-slate-700 bg-black shrink-0">
                                  <img src={thumb} alt="frame" className="w-full h-full object-cover" />
                                  <span className="absolute bottom-0.5 left-0.5 bg-black/80 text-white text-[8px] font-bold tabular-nums px-1 rounded leading-none">{formatTimecode(c.timestamp_seconds ?? 0)}</span>
                                </div>
                              ) : (
                                <div className="w-16 h-10 rounded-md border border-slate-700 bg-slate-800 shrink-0 flex items-center justify-center">
                                  <span className="text-[9px] tabular-nums text-slate-400 font-semibold">{formatTimecode(c.timestamp_seconds ?? 0)}</span>
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-slate-300 leading-relaxed break-words">{c.content}</p>
                                {c.attachment_url && (
                                  <a
                                    href={c.attachment_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="mt-1.5 flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
                                  >
                                    <Paperclip size={9} /> Attachment <ExternalLink size={8} />
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>

                        {replies.length > 0 && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setExpandedCommentIds(prev => {
                                const next = new Set(prev)
                                next.has(c.id) ? next.delete(c.id) : next.add(c.id)
                                return next
                              })
                            }}
                            className="mt-2 ml-9 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                          >
                            {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                          </button>
                        )}
                      </div>

                      {isExpanded && replies.length > 0 && (
                        <div className="border-t border-slate-800 ml-9 mr-3 mb-2 pt-2 space-y-2">
                          {replies.map(r => {
                            const rName = r.author_name || 'Reviewer'
                            const rAvatar = r.author_avatar
                            return (
                              <div key={r.id} className="flex items-start gap-2">
                                <div className="w-5 h-5 rounded-full shrink-0 overflow-hidden bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300">
                                  {rAvatar ? (
                                    <img src={rAvatar} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    getInitials(rName)
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <span className="text-[10px] font-bold text-slate-300">{rName}</span>
                                  <p className="text-[11px] text-slate-400 leading-relaxed break-words">{r.content}</p>
                                  {r.attachment_url && (
                                    <a
                                      href={r.attachment_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="mt-1 flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
                                    >
                                      <Paperclip size={8} /> Attachment
                                    </a>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Footer watermark */}
          <div className="shrink-0 px-4 py-2 border-t border-slate-800 text-center">
            <p className="text-[10px] text-slate-600">Cinematic Workflow · Read-only view</p>
          </div>
        </div>
      </div>
    </div>
  )
}
