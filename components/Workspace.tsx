'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, MessageSquare,
  Send, Trash2, Maximize2, ArrowLeft, Loader2,
  Video, FileVideo, ShieldAlert, Plus, Minus, CheckCircle2, Check,
  X, Volume2, VolumeX, History, Paperclip, ExternalLink, Share2, Pencil,
  Download, ChevronDown, ChevronUp
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { uploadAssetToR2 } from '@/lib/r2/smartUpload';
import { IS_STANDALONE } from '@/lib/mode';
import {
  listNodes, createNode, deleteNode,
  listComments, createComment, updateComment, deleteComment,
  getActiveShareLink, createShareLink, revokeShareLink,
} from '@/lib/actions/workspace';
import { useVideoThumbnails } from '@/hooks/useVideoThumbnails';
import { Badge, Modal, ConfirmDialog } from '@/components/ui';
import type { User, CinematicWorkflow, CinematicNode, CinematicComment } from '@/types';

// All reads and writes go through server actions (lib/actions/workspace.ts) so
// they work in embedded mode, where the browser has no Supabase session. This
// browser client is kept for ONE thing: the realtime comments channel, which
// needs a live socket and only runs in standalone (see the guard below).
const supabase = createClient();

// Spatial pin ({x,y}) plus an optional drawn rectangle in x1/y1/x2/y2 percent —
// the exact jsonb shape this component reads from / writes to comments.annotation.
type Annotation = { x: number; y: number; rect?: { x1: number; y1: number; x2: number; y2: number } };

// The workspace's working comment shape: the shared CinematicComment row with the
// annotation narrowed to this component's rect representation.
type VideoComment = Omit<CinematicComment, 'annotation'> & { annotation?: Annotation | null };

interface WorkspaceProps {
  user: User;
  workflow: CinematicWorkflow;
  onBackList: () => void;
}

// Renders comment text keeping user line breaks intact and turning URLs into
// blue clickable links shown on their own line.
const renderCommentText = (text: string) => {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0;
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="block w-fit max-w-full my-1 text-sky-400 hover:text-sky-300 underline underline-offset-2 break-all"
        >
          {part}
        </a>
      );
    }
    return part;
  });
};

export const Workspace: React.FC<WorkspaceProps> = ({ user, workflow, onBackList }) => {
  const onBack = () => { if (onBackList) onBackList(); else window.history.back(); };
  const [loading, setLoading] = useState(true);

  const [nodes, setNodes] = useState<CinematicNode[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [comments, setComments] = useState<VideoComment[]>([]);
  const [newComment, setNewComment] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(`draft_frame_comment_${workflow.id}`) || '';
    return '';
  });
  const [globalComment, setGlobalComment] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(`draft_global_comment_${workflow.id}`) || '';
    return '';
  });
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [globalAttachmentFile, setGlobalAttachmentFile] = useState<File | null>(null);

  const [acknowledgedComments, setAcknowledgedComments] = useState<Set<string>>(new Set());
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  // Attachment editing (add / replace / remove while editing a comment or reply)
  const [editingAttachmentFile, setEditingAttachmentFile] = useState<File | null>(null);
  const [editingRemoveAttachment, setEditingRemoveAttachment] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmittingGlobal, setIsSubmittingGlobal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingGlobal, setIsUploadingGlobal] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoRetryCount = useRef(0);
  const prevActiveNodeIdRef = useRef<string | null>(null);
  const initialTimeRef = useRef<number | null>(null);
  const savedTimeRef = useRef<number | null>(null);
  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const MAX_VIDEO_RETRIES = 3;

  const [compareComments, setCompareComments] = useState<VideoComment[]>([]);
  const [compareGlobalComment, setCompareGlobalComment] = useState('');
  const [isSubmittingCompareComment, setIsSubmittingCompareComment] = useState(false);

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const videoWrapperRef = useRef<HTMLDivElement>(null);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  const annotationOverlayRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const compareVideoRef = useRef<HTMLVideoElement>(null);
  const rectDraggedRef = useRef(false);
  const frameLogScrollRef = useRef<HTMLDivElement>(null);
  const compareFrameLogScrollRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Range markers: two-step capture (Set start / Set end) for the general-note composer,
  // and loopRange = the segment currently looping when a range marker is clicked.
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const [loopRange, setLoopRange] = useState<{ start: number; end: number } | null>(null);
  // Spatial range creation from the ADD ANNOTATION popup: "Set start" captures the start
  // (time + coordinate) and drops a live marker; the next frame-click asks for "Set end".
  const [pendingRange, setPendingRange] = useState<{ start: number; startAnnotation: { x: number; y: number; rect?: { x1: number; y1: number; x2: number; y2: number } } | null; end: number | null } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoNaturalWidth, setVideoNaturalWidth] = useState(0);
  const [videoNaturalHeight, setVideoNaturalHeight] = useState(0);
  const [videoAreaSize, setVideoAreaSize] = useState({ w: 0, h: 0 });

  const [compareIsPlaying, setCompareIsPlaying] = useState(false);
  const [compareCurrentTime, setCompareCurrentTime] = useState(0);
  const [compareDuration, setCompareDuration] = useState(0);
  const [compareIsMuted, setCompareIsMuted] = useState(true);

  const [pendingAnnotation, setPendingAnnotation] = useState<{x: number, y: number, rect?: {x1:number,y1:number,x2:number,y2:number}} | null>(() => {
    try {
      const saved = localStorage.getItem(`draft_annotation_pos_${workflow.id}`);
      return saved ? JSON.parse(saved).pendingAnnotation : null;
    } catch { return null; }
  });
  const [isDrawingRect, setIsDrawingRect] = useState(false);
  const [rectDraft, setRectDraft] = useState<{x1:number,y1:number,x2:number,y2:number} | null>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(() => {
    try {
      return !!localStorage.getItem(`draft_annotation_pos_${workflow.id}`);
    } catch { return false; }
  });
  const [popoverTarget, setPopoverTarget] = useState<'active' | 'compare'>(() => {
    try {
      const saved = localStorage.getItem(`draft_annotation_pos_${workflow.id}`);
      return saved ? (JSON.parse(saved).popoverTarget ?? 'active') : 'active';
    } catch { return 'active'; }
  });
  const [popoverPos, setPopoverPos] = useState(() => {
    if (typeof window !== 'undefined') return { x: window.innerWidth / 2 - 144, y: 300 };
    return { x: 400, y: 300 };
  });

  // Floating draggable popup for the comment whose annotation is currently visible
  const [floatingPos, setFloatingPos] = useState<{ x: number; y: number } | null>(null);
  const [floatingHidden, setFloatingHidden] = useState(false);
  const floatingDragRef = useRef<{ startMouseX: number; startMouseY: number; startPosX: number; startPosY: number } | null>(null);

  // Drag state for the Add Annotation popover (pixel-positioned, fixed-coords)
  const popoverDragRef = useRef<{ startMouseX: number; startMouseY: number; startPosX: number; startPosY: number } | null>(null);

  // Sidebar comment search
  const [commentSearch, setCommentSearch] = useState('');

  // Inline reply expansion + per-comment reply state
  const [expandedReplyId, setExpandedReplyId] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(`draft_replies_${workflow.id}`);
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const [replyAttachments, setReplyAttachments] = useState<Record<string, File | null>>({});
  const [submittingReplyId, setSubmittingReplyId] = useState<string | null>(null);

  const [isCompareMode, setIsCompareMode] = useState(false);
  // When false, the two videos play/seek independently in compare mode.
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [compareNodeId, setCompareNodeId] = useState<string | null>(null);

  const [isSetupMode, setIsSetupMode] = useState(false);
  const [videoUrlInput, setVideoUrlInput] = useState('');

  const [isShareModalOpen, setIsShareModalOpen] = useState(false);

  const [guestLinkUrl, setGuestLinkUrl] = useState<string | null>(null);
  const [isGeneratingGuestLink, setIsGeneratingGuestLink] = useState(false);
  const [guestLinkCopied, setGuestLinkCopied] = useState(false);
  const [copiedTimestampId, setCopiedTimestampId] = useState<string | null>(null);

  const handleGenerateGuestLink = async () => {
    if (!workflow?.id) return;
    setIsGeneratingGuestLink(true);
    try {
      const existing = await getActiveShareLink(workflow.id);
      const linkId = existing?.id ?? (await createShareLink(workflow.id)).id;
      if (linkId) setGuestLinkUrl(`${window.location.origin}/share/${linkId}`);
    } catch (err: any) {
      alert(err?.message ?? 'Could not create a share link.');
    } finally {
      setIsGeneratingGuestLink(false);
    }
  };

  const handleCopyGuestLink = () => {
    if (!guestLinkUrl) return;
    navigator.clipboard.writeText(guestLinkUrl);
    setGuestLinkCopied(true);
    setTimeout(() => setGuestLinkCopied(false), 2000);
  };

  const handleRevokeGuestLink = async () => {
    if (!guestLinkUrl || !workflow?.id) return;
    const token = guestLinkUrl.split('/share/')[1];
    await revokeShareLink(token);
    setGuestLinkUrl(null);
  };

  const activeNode = useMemo(() => nodes.find(n => n.id === activeNodeId) || null, [nodes, activeNodeId]);
  const compareNode = useMemo(() => nodes.find(n => n.id === compareNodeId) || null, [nodes, compareNodeId]);

  useEffect(() => {
    if (workflow?.id) {
      fetchVideoNode();
    }
  }, [workflow?.id]);

  useEffect(() => {
    if (!workflow?.id) return;
    // Realtime needs a live Supabase socket authenticated by a session — which
    // only exists in standalone. In embedded mode there is no session, so we skip
    // it and rely on optimistic updates from the server actions instead.
    if (!IS_STANDALONE) return;
    const channel = supabase.channel(`cinematic_comments_${workflow.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'cinematic_workflow', table: 'comments' }, (payload) => {
         if (activeNodeId && (payload.new as any).node_id === activeNodeId) fetchComments(activeNodeId);
         if (compareNodeId && (payload.new as any).node_id === compareNodeId) fetchCompareComments(compareNodeId);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [workflow?.id, activeNodeId, compareNodeId]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`draft_frame_comment_${workflow.id}`, newComment);
    }
  }, [newComment, workflow.id]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`draft_global_comment_${workflow.id}`, globalComment);
    }
  }, [globalComment, workflow.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (pendingAnnotation) {
      localStorage.setItem(`draft_annotation_pos_${workflow.id}`, JSON.stringify({ pendingAnnotation, popoverTarget }));
    } else {
      localStorage.removeItem(`draft_annotation_pos_${workflow.id}`);
    }
  }, [pendingAnnotation, popoverTarget, workflow.id]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`draft_replies_${workflow.id}`, JSON.stringify(replyTexts));
    }
  }, [replyTexts, workflow.id]);

  // Read ?t= from URL on mount so a page reload restores the last position.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const t = params.get('t');
      if (t) {
        const time = parseFloat(t);
        if (!isNaN(time)) initialTimeRef.current = time;
      }
    }
  }, []);

  // Keep ?t= in the URL in sync with the current playback position.
  useEffect(() => {
    if (typeof window !== 'undefined' && currentTime > 0) {
      const url = new URL(window.location.href);
      url.searchParams.set('t', currentTime.toFixed(2));
      window.history.replaceState({}, '', url);
    }
  }, [currentTime]);

  useEffect(() => {
    if (activeNodeId) {
      fetchComments(activeNodeId);
    } else {
      setComments([]);
    }
    videoRetryCount.current = 0;
    setVideoError(null);
    // Only clear the annotation draft when the user is switching between nodes.
    // On initial load (null → first nodeId) we preserve the localStorage-restored draft.
    if (prevActiveNodeIdRef.current !== null) {
      setPendingAnnotation(null);
      setIsPopoverOpen(false);
    }
    prevActiveNodeIdRef.current = activeNodeId;
  }, [activeNodeId]);

  useEffect(() => {
    if (compareNodeId) {
      fetchCompareComments(compareNodeId);
    } else {
      setCompareComments([]);
    }
  }, [compareNodeId]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!videoRef.current) return;

      const video = videoRef.current;
      const compareVideo = compareVideoRef.current;
      const frameTime = 1 / 30;
      const jumpTime = 5;

      const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime += e.shiftKey ? jumpTime : frameTime;
          if (isCompareMode && syncEnabled && compareVideo) compareVideo.currentTime = video.currentTime;
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime -= e.shiftKey ? jumpTime : frameTime;
          if (isCompareMode && syncEnabled && compareVideo) compareVideo.currentTime = video.currentTime;
          break;
        case 'l':
        case 'L':
        case 'ArrowUp':
          e.preventDefault();
          setPlaybackRate(prev => { const i = SPEED_STEPS.indexOf(prev); return i < SPEED_STEPS.length - 1 ? SPEED_STEPS[i + 1] : prev; });
          break;
        case 'k':
        case 'K':
        case 'ArrowDown':
          e.preventDefault();
          setPlaybackRate(prev => { const i = SPEED_STEPS.indexOf(prev); return i > 0 ? SPEED_STEPS[i - 1] : prev; });
          break;
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isCompareMode, syncEnabled]);

  // Keep both video elements in sync with the selected playback rate.
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
    if (isCompareMode && compareVideoRef.current) {
      compareVideoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, isCompareMode]);

  const fetchVideoNode = async () => {
    setLoading(true);
    setVideoError(null);
    try {
      const data = await listNodes(workflow.id);

      if (data.length > 0) {
        setNodes(data);
        if (!activeNodeId) setActiveNodeId(data[data.length - 1].id);
      } else {
        setNodes([]);
        setComments([]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchComments = async (nodeId: string) => {
    try {
      setComments(await listComments(nodeId) as any);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchCompareComments = async (nodeId: string) => {
    try {
      setCompareComments(await listComments(nodeId) as any);
    } catch (err) {
      console.error(err);
    }
  };

  const getStreamUrl = (url: string) => {
    if (!url) return '';
    if (url.includes('dropbox.com')) {
      let directUrl = url.split('?')[0];
      return `${directUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com')}?raw=1`;
    }
    const match = url.match(/\/file\/d\/([^\/]+)\//);
    if (match && match[1]) {
      return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
    return url;
  };

  const streamUrl = useMemo(() => getStreamUrl(activeNode?.video_url || ''), [activeNode?.video_url]);
  const compareStreamUrl = useMemo(() => getStreamUrl(compareNode?.video_url || ''), [compareNode?.video_url]);

  // Track the player area's pixel size so the annotation overlay can be sized
  // to exactly match the letterboxed video (object-contain) — see overlayStyle.
  useEffect(() => {
    const el = videoAreaRef.current;
    if (!el) return;
    const update = () => setVideoAreaSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeNodeId, isCompareMode, videoError]);

  // The overlay must sit exactly over the visible video frame (which is
  // letterboxed inside the black area by object-contain) so annotation
  // percentages map correctly. We give it explicit pixel dimensions computed
  // from the container size + video aspect ratio; an aspect-ratio-only box
  // with absolutely-positioned children collapses to zero and can't be clicked.
  const overlayStyle = useMemo<React.CSSProperties>(() => {
    const nw = videoNaturalWidth, nh = videoNaturalHeight;
    const { w: cw, h: ch } = videoAreaSize;
    if (!nw || !nh || !cw || !ch) return { position: 'absolute', inset: 0 };
    const videoAspect = nw / nh;
    const containerAspect = cw / ch;
    let dispW: number, dispH: number;
    if (videoAspect > containerAspect) { dispW = cw; dispH = cw / videoAspect; }
    else { dispH = ch; dispW = ch * videoAspect; }
    return {
      position: 'absolute',
      width: `${dispW}px`,
      height: `${dispH}px`,
      left: `${(cw - dispW) / 2}px`,
      top: `${(ch - dispH) / 2}px`,
    };
  }, [videoNaturalWidth, videoNaturalHeight, videoAreaSize]);

  const startEdit = (c: VideoComment) => {
    setEditingCommentId(c.id);
    setEditingCommentText(c.content || '');
    setEditingAttachmentFile(null);
    setEditingRemoveAttachment(false);
  };
  const cancelEdit = () => {
    setEditingCommentId(null);
    setEditingCommentText('');
    setEditingAttachmentFile(null);
    setEditingRemoveAttachment(false);
  };

  const handleSaveEdit = async (commentId: string) => {
    const text = editingCommentText.trim();
    const current = comments.find(c => c.id === commentId);
    const hadAttachment = !!current?.attachment_url;
    const willHaveAttachment = editingAttachmentFile ? true : (hadAttachment && !editingRemoveAttachment);
    if (!text && !willHaveAttachment) return;

    const patch: Record<string, any> = { content: text };
    let newAttachmentUrl: string | null | undefined = undefined; // undefined = leave unchanged
    if (editingAttachmentFile) {
      try {
        const { publicUrl } = await uploadAssetToR2(editingAttachmentFile, editingAttachmentFile.name);
        newAttachmentUrl = publicUrl;
      } catch (err: any) { alert('Attachment upload failed: ' + err.message); return; }
    } else if (editingRemoveAttachment) {
      newAttachmentUrl = null;
    }
    if (newAttachmentUrl !== undefined) patch.attachment_url = newAttachmentUrl;

    try {
      await updateComment(commentId, patch as { content?: string; attachment_url?: string | null });
    } catch (err: any) {
      alert('Failed to save changes: ' + (err?.message ?? err));
      return;
    }
    setComments(prev => prev.map(x => x.id === commentId
      ? { ...x, content: text, ...(newAttachmentUrl !== undefined ? { attachment_url: newAttachmentUrl } : {}) }
      : x));
    cancelEdit();
  };

  /** Attachment controls shown inside an open comment/reply editor. */
  const renderEditAttachRow = (c: VideoComment) => {
    const keepExisting = !!c.attachment_url && !editingRemoveAttachment && !editingAttachmentFile;
    return (
      <div className="flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
        {editingAttachmentFile ? (
          <span className="inline-flex items-center gap-1.5 bg-slate-900 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-md text-[10px] font-semibold">
            <Paperclip size={10} /> <span className="truncate max-w-[120px]">{editingAttachmentFile.name}</span>
            <button onClick={() => setEditingAttachmentFile(null)} className="hover:text-rose-400" title="Remove"><X size={10} /></button>
          </span>
        ) : keepExisting ? (
          <span className="inline-flex items-center gap-1.5 bg-slate-900 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-md text-[10px] font-semibold">
            <Paperclip size={10} /> Attachment
            <button onClick={() => setEditingRemoveAttachment(true)} className="hover:text-rose-400" title="Remove attachment"><X size={10} /></button>
          </span>
        ) : null}
        <label className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-sky-400 cursor-pointer">
          <Paperclip size={11} /> {(c.attachment_url && !editingRemoveAttachment) || editingAttachmentFile ? 'Replace' : 'Attach'}
          <input type="file" className="hidden" onChange={(e) => { if (e.target.files?.[0]) { setEditingAttachmentFile(e.target.files[0]); setEditingRemoveAttachment(false); } }} />
        </label>
      </div>
    );
  };

  const handlePostReply = async (parent: VideoComment) => {
    if (!activeNode) return;
    const text = (replyTexts[parent.id] || '').trim();
    const file = replyAttachments[parent.id] || null;
    if (!text && !file) return;
    setSubmittingReplyId(parent.id);
    let uploadedUrl: string | null = null;
    if (file) {
      try {
        const { publicUrl } = await uploadAssetToR2(file, file.name);
        uploadedUrl = publicUrl;
      } catch (err: any) {
        alert('Attachment upload failed: ' + err.message);
        setSubmittingReplyId(null);
        return;
      }
    }
    try {
      const data = await createComment({
        node_id: activeNode.id,
        content: text,
        timestamp_seconds: parent.timestamp_seconds,
        annotation: null,
        attachment_url: uploadedUrl,
        parent_id: parent.id,
      });
      setComments(prev => [...prev, data as any].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
      setReplyTexts(prev => ({ ...prev, [parent.id]: '' }));
      setReplyAttachments(prev => ({ ...prev, [parent.id]: null }));
      setExpandedReplyId(null);
    } catch (err: any) {
      alert('Reply failed: ' + (err?.message ?? err));
    } finally {
      setSubmittingReplyId(null);
    }
  };

  const handlePopoverDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    popoverDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: popoverPos.x,
      startPosY: popoverPos.y,
    };
    const onMove = (ev: MouseEvent) => {
      if (!popoverDragRef.current) return;
      const dx = ev.clientX - popoverDragRef.current.startMouseX;
      const dy = ev.clientY - popoverDragRef.current.startMouseY;
      setPopoverPos({
        x: popoverDragRef.current.startPosX + dx,
        y: popoverDragRef.current.startPosY + dy,
      });
    };
    const onUp = () => {
      popoverDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleFloatingDragStart = (e: React.MouseEvent) => {
    if (!videoAreaRef.current || !visibleAnnotation?.annotation) return;
    e.preventDefault();
    e.stopPropagation();
    const defaultPos = {
      x: Math.min(70, (visibleAnnotation.annotation.x ?? 50) + 6),
      y: Math.max(2, (visibleAnnotation.annotation.y ?? 50) - 18),
    };
    const currentPos = floatingPos ?? defaultPos;
    floatingDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: currentPos.x,
      startPosY: currentPos.y,
    };
    const onMove = (ev: MouseEvent) => {
      if (!floatingDragRef.current) return;
      const r = (annotationOverlayRef.current || videoAreaRef.current)!.getBoundingClientRect();
      const dxPct = ((ev.clientX - floatingDragRef.current.startMouseX) / r.width) * 100;
      const dyPct = ((ev.clientY - floatingDragRef.current.startMouseY) / r.height) * 100;
      setFloatingPos({
        x: Math.max(0, Math.min(90, floatingDragRef.current.startPosX + dxPct)),
        y: Math.max(0, Math.min(90, floatingDragRef.current.startPosY + dyPct)),
      });
    };
    const onUp = () => {
      floatingDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handlePostComment = async () => {
    if ((!activeNode && popoverTarget === 'active') || (!compareNodeId && popoverTarget === 'compare') || (!newComment.trim() && !attachmentFile)) return;
    setIsSubmitting(true);

    let uploadedUrl = null;

    if (attachmentFile) {
        setIsUploading(true);
        try {
            const { publicUrl } = await uploadAssetToR2(attachmentFile, attachmentFile.name);
            uploadedUrl = publicUrl;
        } catch (err: any) {
            alert('Attachment upload failed: ' + err.message);
            setIsSubmitting(false);
            setIsUploading(false);
            return;
        }
        setIsUploading(false);
    }

    const targetNodeId = popoverTarget === 'active' ? activeNode!.id : compareNodeId!;
    const targetTimestamp = popoverTarget === 'active' ? (videoRef.current?.currentTime || 0) : (compareVideoRef.current?.currentTime || 0);

    // A finalized spatial range (start + end captured) posts as a range marker anchored
    // at its start coordinate; otherwise it's a normal point annotation at the playhead.
    const isRange = !!pendingRange && pendingRange.end != null;

    try {
      const data = await createComment({
        node_id: targetNodeId,
        content: newComment.trim(),
        timestamp_seconds: isRange ? pendingRange!.start : targetTimestamp,
        end_seconds: isRange ? pendingRange!.end : null,
        annotation: isRange ? pendingRange!.startAnnotation : pendingAnnotation,
        attachment_url: uploadedUrl,
      });
      if (popoverTarget === 'active') {
          setComments(prev => [...prev, data as any].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
      } else {
          setCompareComments(prev => [...prev, data as any].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
      }
      setNewComment('');
      setAttachmentFile(null);
      setIsPopoverOpen(false);
      setPendingAnnotation(null);
      setPendingRange(null);
      setRectDraft(null);
      if (isSidebarCollapsed) setIsSidebarCollapsed(false);
    } catch (err: any) {
      alert("Failed to post comment. Error: " + (err?.message ?? err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Spatial range creation (ADD ANNOTATION popup) ──────────────────────────
  const handleSetRangeStart = () => {
    if (popoverTarget !== 'active') return;
    const start = videoRef.current?.currentTime || 0;
    setPendingRange({ start, startAnnotation: pendingAnnotation, end: null });
    setIsPopoverOpen(false);      // hide the comment box; let the user scrub freely
    setPendingAnnotation(null);
    setNewComment('');
    setAttachmentFile(null);
  };

  const handleSetRangeEnd = () => {
    const end = videoRef.current?.currentTime || 0;
    setPendingRange(pr => (pr && end > pr.start) ? { ...pr, end } : pr);
  };

  const cancelPendingRange = () => {
    setPendingRange(null);
    setIsPopoverOpen(false);
    setPendingAnnotation(null);
    setNewComment('');
    setAttachmentFile(null);
  };

  const handlePostGlobalComment = async () => {
    if (!activeNode || (!globalComment.trim() && !globalAttachmentFile)) return;
    setIsSubmittingGlobal(true);

    let uploadedUrl = null;

    if (globalAttachmentFile) {
        setIsUploadingGlobal(true);
        try {
            const { publicUrl } = await uploadAssetToR2(globalAttachmentFile, globalAttachmentFile.name);
            uploadedUrl = publicUrl;
        } catch (err: any) {
            alert('Attachment upload failed: ' + err.message);
            setIsSubmittingGlobal(false);
            setIsUploadingGlobal(false);
            return;
        }
        setIsUploadingGlobal(false);
    }

    // Range marker: when a start (and end) has been captured, anchor the marker at the
    // start and store the segment end. Otherwise it's a normal point marker at the playhead.
    const hasRange = rangeStart != null && rangeEnd != null && rangeEnd > rangeStart;

    try {
      const data = await createComment({
        node_id: activeNode.id,
        content: globalComment.trim(),
        timestamp_seconds: rangeStart != null ? rangeStart : (videoRef.current?.currentTime || 0),
        end_seconds: hasRange ? rangeEnd : null,
        annotation: null,
        attachment_url: uploadedUrl,
      });
      setComments(prev => [...prev, data as any].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
      setGlobalComment('');
      setGlobalAttachmentFile(null);
      setRangeStart(null);
      setRangeEnd(null);
    } catch (err: any) {
      alert("Failed to post general comment. Error: " + (err?.message ?? err));
    } finally {
      setIsSubmittingGlobal(false);
    }
  };

  const handlePostCompareGlobalComment = async () => {
    if (!compareNodeId || !compareGlobalComment.trim()) return;
    setIsSubmittingCompareComment(true);
    try {
      const data = await createComment({
        node_id: compareNodeId,
        content: compareGlobalComment.trim(),
        timestamp_seconds: compareVideoRef.current?.currentTime || 0,
        annotation: null,
        attachment_url: null,
      });
      setCompareComments(prev => [...prev, data as any].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
      setCompareGlobalComment('');
    } catch (err: any) {
      alert("Failed to post comment. Error: " + (err?.message ?? err));
    } finally {
      setIsSubmittingCompareComment(false);
    }
  };

  const handleSetupNode = async () => {
    if (!videoUrlInput.trim()) return;
    setLoading(true); setVideoError(null);
    try {
      const data = await createNode(workflow.id, videoUrlInput.trim());
      setNodes(prev => [...prev, data]);
      setActiveNodeId(data.id);
      setIsSetupMode(false);
    } catch (err: any) {
      alert(err?.message ?? 'Failed to add the video.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteNode = async () => {
    if (!activeNode) return;
    setLoading(true);
    try {
      await deleteNode(activeNode.id);
      const newNodes = nodes.filter(n => n.id !== activeNode.id);
      setNodes(newNodes);
      setActiveNodeId(newNodes.length > 0 ? newNodes[newNodes.length - 1].id : null);
      if (compareNodeId === activeNode.id) setCompareNodeId(null);
    } catch (err: any) { alert("Delete failed: " + err.message); }
    finally { setShowDeleteConfirm(false); setLoading(false); }
  };

  const togglePlay = () => {
    if (isPopoverOpen) return;
    if (videoRef.current) {
      if (videoRef.current.paused) {
          videoRef.current.play().catch(() => setVideoError('Playback failed'));
          if (isCompareMode && syncEnabled && compareVideoRef.current) compareVideoRef.current.play().catch(() => {});
      } else {
          videoRef.current.pause();
          if (isCompareMode && syncEnabled && compareVideoRef.current) compareVideoRef.current.pause();
      }
    }
  };

  const toggleComparePlay = () => {
    if (compareVideoRef.current) {
      if (compareVideoRef.current.paused) {
          compareVideoRef.current.play().catch(() => {});
          if (syncEnabled && videoRef.current) videoRef.current.play().catch(() => {});
      } else {
          compareVideoRef.current.pause();
          if (syncEnabled && videoRef.current) videoRef.current.pause();
      }
    }
  };

  const toggleCompareMute = () => {
    if (compareVideoRef.current) {
      compareVideoRef.current.muted = !compareVideoRef.current.muted;
      setCompareIsMuted(compareVideoRef.current.muted);
    }
  };

  const handleCompareTimeUpdate = () => {
    if (compareVideoRef.current) {
      setCompareCurrentTime(compareVideoRef.current.currentTime);
    }
  };

  const handleCompareSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = percent * compareDuration;
    if (compareVideoRef.current) {
      compareVideoRef.current.currentTime = newTime;
      setCompareCurrentTime(newTime);
    }
    if (syncEnabled && videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const jumpToTime = (seconds: number | null | undefined) => {
    if (seconds == null || isNaN(seconds)) return;
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.pause();
      if (isCompareMode && syncEnabled && compareVideoRef.current) {
          compareVideoRef.current.currentTime = seconds;
          compareVideoRef.current.pause();
      }
      setIsPlaying(false);
      setIsPopoverOpen(false);
      setPendingAnnotation(null);
    }
  };

  const handleMarkerClick = (e: React.MouseEvent, commentId: string, seconds: number) => {
    e.stopPropagation();
    const clicked = comments.find(x => x.id === commentId);
    if (clicked?.end_seconds != null && clicked.end_seconds > seconds && videoRef.current) {
      // Range marker: seek to start and loop just this segment.
      setLoopRange({ start: seconds, end: clicked.end_seconds });
      videoRef.current.currentTime = seconds;
      setCurrentTime(seconds);
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      setLoopRange(null);
      jumpToTime(seconds);
    }
    setActiveCommentId(commentId);

    if (isSidebarCollapsed) {
        setIsSidebarCollapsed(false);
    }

    setTimeout(() => {
        const element = document.getElementById(`comment-${commentId}`);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 100);
  };

  const formatTimestamp = (seconds: number | null | undefined) => {
    if (seconds == null || isNaN(seconds)) return "00;00;00;00";
    const hrs   = Math.floor(seconds / 3600);
    const mins  = Math.floor((seconds % 3600) / 60);
    const secs  = Math.floor(seconds % 60);
    const frames = Math.floor((seconds % 1) * 30);
    return `${String(hrs).padStart(2,'0')};${String(mins).padStart(2,'0')};${String(secs).padStart(2,'0')};${String(frames).padStart(2,'0')}`;
  };

  // Compact mm:ss (or h:mm:ss) label used for range chips / loop indicator / sidebar range labels.
  const formatClock = (seconds: number | null | undefined) => {
    if (seconds == null || isNaN(seconds)) return "0:00";
    const hrs  = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return hrs > 0
      ? `${hrs}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`
      : `${mins}:${String(secs).padStart(2,'0')}`;
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime;
    // Loop the active range marker: when playback passes its end, jump back to its start.
    if (loopRange && t >= loopRange.end) {
      videoRef.current.currentTime = loopRange.start;
      setCurrentTime(loopRange.start);
      return;
    }
    setCurrentTime(t);
    if (isCompareMode && syncEnabled && compareVideoRef.current && !compareVideoRef.current.ended) {
      if (Math.abs(compareVideoRef.current.currentTime - t) > 0.15) {
        compareVideoRef.current.currentTime = t;
      }
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = percent * duration;

    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
    if (isCompareMode && syncEnabled && compareVideoRef.current) {
      compareVideoRef.current.currentTime = newTime;
      setCompareCurrentTime(newTime);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
      if (videoRef.current.muted) setVolume(0);
      else setVolume(1);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && videoWrapperRef.current) {
      videoWrapperRef.current.requestFullscreen().catch(err => console.error(err));
    } else {
      document.exitFullscreen();
    }
  };

  const handleVideoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (rectDraggedRef.current) { rectDraggedRef.current = false; return; }
    if (isPopoverOpen) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (videoRef.current) {
      videoRef.current.pause();
      if (isCompareMode && compareVideoRef.current) compareVideoRef.current.pause();
      setIsPlaying(false);
    }

    setPendingAnnotation({ x, y });
    setPopoverPos({ x: e.clientX, y: e.clientY });
    setPopoverTarget('active');
    setNewComment('');
    setAttachmentFile(null);
    setIsPopoverOpen(true);
  };

  const handleCompareVideoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (rectDraggedRef.current) { rectDraggedRef.current = false; return; }
    if (isPopoverOpen) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (compareVideoRef.current) {
      compareVideoRef.current.pause();
      if (videoRef.current) videoRef.current.pause();
      setCompareIsPlaying(false);
    }

    setPendingAnnotation({ x, y });
    setPopoverPos({ x: e.clientX, y: e.clientY });
    setPopoverTarget('compare');
    setIsPopoverOpen(true);
  };

  const handleVideoMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (isPopoverOpen) return;
    const divRect = e.currentTarget.getBoundingClientRect();
    const startX = ((e.clientX - divRect.left) / divRect.width) * 100;
    const startY = ((e.clientY - divRect.top) / divRect.height) * 100;
    let hasDragged = false;
    const onMove = (mv: MouseEvent) => {
      const x2 = Math.max(0, Math.min(100, ((mv.clientX - divRect.left) / divRect.width) * 100));
      const y2 = Math.max(0, Math.min(100, ((mv.clientY - divRect.top) / divRect.height) * 100));
      if (!hasDragged && (Math.abs(x2 - startX) > 1.5 || Math.abs(y2 - startY) > 1.5)) {
        hasDragged = true;
        setIsDrawingRect(true);
        if (videoRef.current) { videoRef.current.pause(); setIsPlaying(false); }
        if (isCompareMode && compareVideoRef.current) compareVideoRef.current.pause();
      }
      if (hasDragged) setRectDraft({ x1: startX, y1: startY, x2, y2 });
    };
    const onUp = (up: MouseEvent) => {
      if (up.button !== 0) return;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!hasDragged) { setRectDraft(null); setIsDrawingRect(false); return; }
      setIsDrawingRect(false);
      const x2f = Math.max(0, Math.min(100, ((up.clientX - divRect.left) / divRect.width) * 100));
      const y2f = Math.max(0, Math.min(100, ((up.clientY - divRect.top) / divRect.height) * 100));
      const finalRect = {
        x1: Math.min(startX, x2f), y1: Math.min(startY, y2f),
        x2: Math.max(startX, x2f), y2: Math.max(startY, y2f),
      };
      if (finalRect.x2 - finalRect.x1 < 2 || finalRect.y2 - finalRect.y1 < 2) { setRectDraft(null); return; }
      setRectDraft(finalRect);
      const cx = (finalRect.x1 + finalRect.x2) / 2;
      const cy = (finalRect.y1 + finalRect.y2) / 2;
      setPendingAnnotation({ x: cx, y: cy, rect: finalRect });
      setPopoverPos({ x: up.clientX, y: up.clientY });
      setPopoverTarget('active');
      setNewComment('');
      setAttachmentFile(null);
      rectDraggedRef.current = true;
      setIsPopoverOpen(true);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleCompareVideoMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (isPopoverOpen) return;
    const divRect = e.currentTarget.getBoundingClientRect();
    const startX = ((e.clientX - divRect.left) / divRect.width) * 100;
    const startY = ((e.clientY - divRect.top) / divRect.height) * 100;
    let hasDragged = false;
    const onMove = (mv: MouseEvent) => {
      const x2 = Math.max(0, Math.min(100, ((mv.clientX - divRect.left) / divRect.width) * 100));
      const y2 = Math.max(0, Math.min(100, ((mv.clientY - divRect.top) / divRect.height) * 100));
      if (!hasDragged && (Math.abs(x2 - startX) > 1.5 || Math.abs(y2 - startY) > 1.5)) {
        hasDragged = true;
        setIsDrawingRect(true);
        if (compareVideoRef.current) { compareVideoRef.current.pause(); setCompareIsPlaying(false); }
        if (videoRef.current) videoRef.current.pause();
      }
      if (hasDragged) setRectDraft({ x1: startX, y1: startY, x2, y2 });
    };
    const onUp = (up: MouseEvent) => {
      if (up.button !== 0) return;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!hasDragged) { setRectDraft(null); setIsDrawingRect(false); return; }
      setIsDrawingRect(false);
      const x2f = Math.max(0, Math.min(100, ((up.clientX - divRect.left) / divRect.width) * 100));
      const y2f = Math.max(0, Math.min(100, ((up.clientY - divRect.top) / divRect.height) * 100));
      const finalRect = {
        x1: Math.min(startX, x2f), y1: Math.min(startY, y2f),
        x2: Math.max(startX, x2f), y2: Math.max(startY, y2f),
      };
      if (finalRect.x2 - finalRect.x1 < 2 || finalRect.y2 - finalRect.y1 < 2) { setRectDraft(null); return; }
      setRectDraft(finalRect);
      const cx = (finalRect.x1 + finalRect.x2) / 2;
      const cy = (finalRect.y1 + finalRect.y2) / 2;
      setPendingAnnotation({ x: cx, y: cy, rect: finalRect });
      setPopoverPos({ x: up.clientX, y: up.clientY });
      setPopoverTarget('compare');
      setNewComment('');
      setAttachmentFile(null);
      rectDraggedRef.current = true;
      setIsPopoverOpen(true);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const visibleAnnotation = useMemo(() => {
    if (pendingAnnotation && popoverTarget === 'active') return null;
    for (const comment of comments) {
      if (comment.annotation && currentTime >= comment.timestamp_seconds - 0.5 && currentTime <= comment.timestamp_seconds + 1.0) {
        return comment;
      }
    }
    return null;
  }, [comments, currentTime, pendingAnnotation, popoverTarget]);

  const visibleCompareAnnotation = useMemo(() => {
    if (pendingAnnotation && popoverTarget === 'compare') return null;
    for (const comment of compareComments) {
      if (comment.annotation && compareCurrentTime >= comment.timestamp_seconds - 0.5 && compareCurrentTime <= comment.timestamp_seconds + 1.0) {
        return comment;
      }
    }
    return null;
  }, [compareComments, compareCurrentTime, pendingAnnotation, popoverTarget]);

  const commentTimecodes = useMemo(
    () => Array.from(new Set(comments.map(c => Math.max(0, Math.floor(c.timestamp_seconds || 0))))),
    [comments]
  );
  const commentThumbs = useVideoThumbnails({ videoUrl: streamUrl, timecodes: commentTimecodes });

  useEffect(() => {
    setFloatingPos(null);
    setFloatingHidden(false);
  }, [visibleAnnotation?.id]);

  const topLevelComments = useMemo(() => comments.filter(c => !c.parent_id), [comments]);
  const repliesByParent = useMemo(() => {
    const map: Record<string, VideoComment[]> = {};
    for (const c of comments) {
      if (c.parent_id) {
        (map[c.parent_id] ||= []).push(c);
      }
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return map;
  }, [comments]);

  const filteredTopLevelComments = useMemo(() => {
    const q = commentSearch.trim().toLowerCase();
    if (!q) return topLevelComments;
    return topLevelComments.filter(c => {
      if ((c.content || '').toLowerCase().includes(q)) return true;
      if ((c.profiles?.full_name || '').toLowerCase().includes(q)) return true;
      const replies = repliesByParent[c.id] || [];
      return replies.some(r =>
        (r.content || '').toLowerCase().includes(q) ||
        (r.profiles?.full_name || '').toLowerCase().includes(q)
      );
    });
  }, [topLevelComments, repliesByParent, commentSearch]);

  if (!workflow) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-950">
        <Loader2 className="animate-spin text-sky-400" size={32} />
      </div>
    );
  }

  return (
    <div className="dark fixed inset-0 z-[9999] flex flex-col animate-in fade-in duration-700 font-sans text-slate-200 bg-slate-950 overflow-hidden">

      <div className="flex items-center justify-between px-4 py-3 shrink-0 border-b border-slate-800/80">
        <div className="flex items-center gap-4 min-w-0">
           <button onClick={onBack} className="text-slate-400 hover:text-white transition-colors shrink-0" title="Exit workspace">
             <ArrowLeft size={20} strokeWidth={2.5}/>
           </button>
           {activeNode && nodes.length > 0 && (
             <select
               value={activeNodeId || ''}
               onChange={(e) => setActiveNodeId(e.target.value || null)}
               className="bg-slate-800/80 hover:bg-slate-800 text-slate-200 text-xs font-bold px-3 py-1.5 rounded-md border border-slate-700 outline-none cursor-pointer"
               title="Switch version"
             >
               {nodes.map((n, idx) => (
                 <option key={n.id} value={n.id}>V{idx + 1}</option>
               ))}
             </select>
           )}
           <h1 className="text-sm font-semibold text-slate-100 truncate" title={workflow.title}>{workflow.title}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
           {activeNode && (
             <button onClick={() => setIsShareModalOpen(true)} className="text-slate-300 hover:text-white bg-slate-800/60 hover:bg-slate-800 px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors" title="Share">
                <Send size={13} /> Share
             </button>
           )}
           {activeNode && (
              <button onClick={() => setShowDeleteConfirm(true)} className="p-2 text-slate-400 hover:text-rose-400 transition-colors" title="Purge Video Node">
                 <Trash2 size={16} />
              </button>
           )}
           <button onClick={() => { setVideoUrlInput(''); setIsSetupMode(true); }} className="p-2 text-slate-400 hover:text-sky-400 transition-colors" title="Initialize Video Node">
              <Plus size={16} strokeWidth={2.5}/>
           </button>
           <div className="w-8 h-8 rounded-full bg-rose-500 flex items-center justify-center text-white text-xs font-bold ml-2" title={user.full_name}>
              {user.full_name?.charAt(0).toUpperCase() || 'U'}
           </div>
        </div>
      </div>

      {nodes.length > 1 && (
        <div className="flex items-center gap-2 px-4 py-2 shrink-0 border-b border-slate-800/80 bg-slate-900/40">
            <button
                onClick={() => setIsCompareMode(!isCompareMode)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${isCompareMode ? 'bg-sky-600 text-white' : 'bg-slate-800/60 text-slate-300 hover:bg-slate-800'}`}
            >
                Compare Mode
            </button>
            {isCompareMode && (
                <select
                    value={compareNodeId || ''}
                    onChange={(e) => setCompareNodeId(e.target.value || null)}
                    className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-xs font-semibold text-slate-200 outline-none cursor-pointer"
                >
                    <option value="">Select VS...</option>
                    {nodes.filter(n => n.id !== activeNodeId).map((n) => (
                        <option key={n.id} value={n.id}>Compare to V{nodes.findIndex(x => x.id === n.id) + 1}</option>
                    ))}
                </select>
            )}
        </div>
      )}

      <div className={`flex-1 flex ${isCompareMode ? 'flex-col' : 'flex-row'} gap-0 overflow-hidden relative min-h-0`}>
        <div className={`flex gap-0 min-w-0 h-full min-h-0 ${isCompareMode ? 'flex-1 flex-col' : 'flex-[2] flex-col'}`}>
           <div className={`flex-1 flex gap-0 min-h-0 ${isCompareMode ? 'flex-row' : 'flex-col'}`}>

               <div ref={videoWrapperRef} className="flex-1 bg-black group flex flex-col min-h-0">
                  <div ref={videoAreaRef} className="flex-1 relative overflow-hidden min-h-0 bg-black">

                  {!activeNode ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-12 text-center space-y-6">
                       <div className="w-20 h-20 bg-white dark:bg-slate-800/5 rounded-[2rem] flex items-center justify-center text-gray-700 dark:text-gray-300 shadow-inner">
                          <FileVideo size={40} className="opacity-20" />
                       </div>
                       <p className="text-white text-sm font-black uppercase tracking-widest">No Video node deployed</p>
                    </div>
                  ) : videoError ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-12 text-center space-y-6">
                       <ShieldAlert size={40} className="text-rose-500" />
                       <p className="text-white text-sm font-bold uppercase">Stream Link Blocked or Invalid</p>
                       <button
                         onClick={() => {
                           if (videoRef.current) savedTimeRef.current = videoRef.current.currentTime;
                           videoRetryCount.current = 0;
                           setVideoError(null);
                           if (videoRef.current) videoRef.current.load();
                         }}
                         className="px-6 py-2.5 bg-white dark:bg-slate-800/10 hover:bg-white dark:bg-slate-800/20 text-white border border-white/20 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2"
                       >
                         <SkipBack size={14} /> Retry
                       </button>
                    </div>
                  ) : (
                    <>
                      <video
                        key={streamUrl}
                        ref={videoRef}
                        src={streamUrl}
                        className="absolute inset-0 w-full h-full object-contain"
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={() => {
                          setDuration(videoRef.current?.duration || 0);
                          if (videoRef.current) {
                            setVideoNaturalWidth(videoRef.current.videoWidth);
                            setVideoNaturalHeight(videoRef.current.videoHeight);
                          }
                          const restoreTime = savedTimeRef.current ?? initialTimeRef.current;
                          if (restoreTime !== null && videoRef.current) {
                            videoRef.current.currentTime = restoreTime;
                            setCurrentTime(restoreTime);
                          }
                          savedTimeRef.current = null;
                          initialTimeRef.current = null;
                        }}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onStalled={() => {
                          if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
                          stallTimerRef.current = setTimeout(() => {
                            if (videoRef.current && !videoRef.current.ended) {
                              videoRef.current.currentTime = videoRef.current.currentTime;
                            }
                          }, 3000);
                        }}
                        onCanPlay={() => {
                          if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null; }
                        }}
                        onError={() => {
                          if (videoRef.current) savedTimeRef.current = videoRef.current.currentTime;
                          if (videoRetryCount.current < MAX_VIDEO_RETRIES) {
                            videoRetryCount.current += 1;
                            const delay = videoRetryCount.current * 1000;
                            setTimeout(() => { if (videoRef.current) videoRef.current.load(); }, delay);
                          } else {
                            setVideoError('Source blocked');
                          }
                        }}
                        playsInline
                      />

                       <div
                         ref={annotationOverlayRef}
                         className="cursor-crosshair"
                         style={overlayStyle}
                         onClick={handleVideoClick}
                         onContextMenu={(e) => e.preventDefault()}
                         onMouseDown={handleVideoMouseDown}
                       >
                         {isDrawingRect && rectDraft && (() => {
                            const rx1 = Math.min(rectDraft.x1, rectDraft.x2); const ry1 = Math.min(rectDraft.y1, rectDraft.y2);
                            const rw = Math.abs(rectDraft.x2 - rectDraft.x1); const rh = Math.abs(rectDraft.y2 - rectDraft.y1);
                            return (
                              <div className="absolute border-2 border-orange-400 bg-orange-400/10 pointer-events-none z-10" style={{ left: `${rx1}%`, top: `${ry1}%`, width: `${rw}%`, height: `${rh}%` }}>
                                <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                                <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                                <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                                <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                              </div>
                            );
                         })()}

                         {pendingAnnotation && popoverTarget === 'active' && (
                           pendingAnnotation.rect ? (
                             <div className="absolute border-2 border-orange-400 bg-orange-400/10 pointer-events-none z-10" style={{ left: `${pendingAnnotation.rect.x1}%`, top: `${pendingAnnotation.rect.y1}%`, width: `${pendingAnnotation.rect.x2 - pendingAnnotation.rect.x1}%`, height: `${pendingAnnotation.rect.y2 - pendingAnnotation.rect.y1}%` }}>
                               <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                               <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                               <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                               <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-orange-400"/>
                             </div>
                           ) : (
                             <div className="absolute w-8 h-8 -ml-4 -mt-4 bg-rose-500 rounded-full border-4 border-white shadow-xl animate-bounce pointer-events-none z-10 flex items-center justify-center text-white" style={{ left: `${pendingAnnotation.x}%`, top: `${pendingAnnotation.y}%` }}><span className="w-2 h-2 bg-white rounded-full"></span></div>
                           )
                         )}

                         {visibleAnnotation && visibleAnnotation.annotation && (
                           visibleAnnotation.annotation.rect ? (
                             <div className="absolute border-2 border-[#3A9BDC] bg-[#3A9BDC]/10 pointer-events-none z-10" style={{ left: `${visibleAnnotation.annotation.rect.x1}%`, top: `${visibleAnnotation.annotation.rect.y1}%`, width: `${visibleAnnotation.annotation.rect.x2 - visibleAnnotation.annotation.rect.x1}%`, height: `${visibleAnnotation.annotation.rect.y2 - visibleAnnotation.annotation.rect.y1}%` }}>
                               <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-[#3A9BDC]"/>
                               <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-[#3A9BDC]"/>
                               <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-[#3A9BDC]"/>
                               <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-[#3A9BDC]"/>
                             </div>
                           ) : (
                             <div className="absolute w-8 h-8 -ml-4 -mt-4 bg-[#3A9BDC] rounded-full border-4 border-white shadow-xl pointer-events-none z-10 flex items-center justify-center text-white transition-all duration-300" style={{ left: `${visibleAnnotation.annotation.x}%`, top: `${visibleAnnotation.annotation.y}%` }}><span className="w-2 h-2 bg-white dark:bg-slate-800 rounded-full"></span></div>
                           )
                         )}

                         {visibleAnnotation && visibleAnnotation.annotation && !floatingHidden && (() => {
                            const ann = visibleAnnotation.annotation!;
                            const defaultPos = {
                               x: Math.min(70, (ann.x ?? 50) + 6),
                               y: Math.max(2, (ann.y ?? 50) - 18),
                            };
                            const pos = floatingPos ?? defaultPos;
                            return (
                               <>
                                  <svg className="absolute inset-0 w-full h-full pointer-events-none z-20" preserveAspectRatio="none">
                                     <line
                                        x1={`${ann.rect ? (ann.rect.x1 + ann.rect.x2) / 2 : ann.x}%`}
                                        y1={`${ann.rect ? ann.rect.y2 : ann.y}%`}
                                        x2={`${pos.x + 3}%`}
                                        y2={`${pos.y + 4}%`}
                                        stroke="#fb923c"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                     />
                                  </svg>
                                  <div
                                     className="absolute z-30 bg-slate-900/95 backdrop-blur-sm border border-slate-700 rounded-lg shadow-2xl w-72 pointer-events-auto select-none"
                                     style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                                     onClick={(e) => e.stopPropagation()}
                                  >
                                     <div
                                        className="flex items-center justify-between gap-2 p-2.5 cursor-grab active:cursor-grabbing"
                                        onMouseDown={handleFloatingDragStart}
                                     >
                                        <div className="flex items-center gap-2 min-w-0">
                                           <div className="w-6 h-6 rounded-full bg-rose-500 flex items-center justify-center overflow-hidden shrink-0">
                                              {visibleAnnotation.profiles?.avatar_url ? <img src={visibleAnnotation.profiles.avatar_url} className="w-full h-full object-cover" /> : <span className="text-[10px] font-bold text-white">{visibleAnnotation.profiles?.full_name?.charAt(0).toUpperCase() || 'U'}</span>}
                                           </div>
                                           <div className="min-w-0">
                                              <p className="text-xs font-semibold text-white truncate leading-tight">{visibleAnnotation.profiles?.full_name || 'System'}</p>
                                              <p className="text-[10px] text-slate-400">{new Date(visibleAnnotation.created_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</p>
                                           </div>
                                        </div>
                                        <div className="flex items-center gap-0.5 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
                                           {visibleAnnotation.user_id === user.id && editingCommentId !== visibleAnnotation.id && (
                                              <button onClick={(e) => { e.stopPropagation(); startEdit(visibleAnnotation); }} className="text-slate-400 hover:text-sky-400 p-1 rounded hover:bg-slate-800" title="Edit"><Pencil size={13}/></button>
                                           )}
                                           <button onClick={async (e) => { e.stopPropagation(); await deleteComment(visibleAnnotation.id); setComments(prev => prev.filter(x => x.id !== visibleAnnotation.id)); setFloatingHidden(true); }} className="text-slate-400 hover:text-rose-400 p-1 rounded hover:bg-slate-800" title="Delete"><Trash2 size={13}/></button>
                                           <button onClick={(e) => { e.stopPropagation(); setFloatingHidden(true); }} className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800" title="Close"><X size={14}/></button>
                                        </div>
                                     </div>
                                     {editingCommentId === visibleAnnotation.id ? (
                                        <div className="px-3 pb-2 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                                           <div className="flex items-start gap-1">
                                              <textarea autoFocus value={editingCommentText} onChange={(e) => setEditingCommentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(visibleAnnotation.id); } if (e.key === 'Escape') { cancelEdit(); } }} rows={Math.min(10, Math.max(3, editingCommentText.split('\n').length + 1))} className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 leading-snug outline-none focus:border-sky-500 resize-y" />
                                              <button onClick={() => handleSaveEdit(visibleAnnotation.id)} className="p-1 text-sky-400 hover:text-sky-300 shrink-0" title="Save (Enter)"><Check size={12}/></button>
                                              <button onClick={cancelEdit} className="p-1 text-slate-400 hover:text-slate-200 shrink-0" title="Cancel (Esc)"><X size={12}/></button>
                                           </div>
                                           {renderEditAttachRow(visibleAnnotation)}
                                        </div>
                                     ) : (
                                        <>
                                           {visibleAnnotation.content && (
                                              <div className="px-3 pb-2">
                                                 <p className="text-sm text-slate-100 leading-snug break-words whitespace-pre-wrap">{renderCommentText(visibleAnnotation.content)}</p>
                                              </div>
                                           )}
                                           {visibleAnnotation.attachment_url && (
                                              <div className="px-3 pb-2">
                                                 <a href={visibleAnnotation.attachment_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-md text-[10px] font-semibold hover:bg-slate-700 transition-colors">
                                                    <ExternalLink size={9} /> Attachment
                                                 </a>
                                              </div>
                                           )}
                                        </>
                                     )}
                                     <div className="px-2 pb-2">
                                        <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-md px-2 py-1">
                                           <input
                                              type="text"
                                              value={replyTexts[visibleAnnotation.id] || ''}
                                              onChange={(e) => setReplyTexts(prev => ({ ...prev, [visibleAnnotation.id]: e.target.value }))}
                                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(visibleAnnotation); } }}
                                              placeholder="Reply to thread..."
                                              className="flex-1 bg-transparent border-none outline-none text-xs text-slate-200 placeholder:text-slate-500"
                                           />
                                           <button
                                              onClick={() => handlePostReply(visibleAnnotation)}
                                              disabled={!replyTexts[visibleAnnotation.id]?.trim() || submittingReplyId === visibleAnnotation.id}
                                              className="p-1 text-sky-400 hover:text-sky-300 disabled:opacity-40 transition-colors"
                                              title="Send reply"
                                           >
                                              {submittingReplyId === visibleAnnotation.id ? <Loader2 size={12} className="animate-spin"/> : <Send size={12}/>}
                                           </button>
                                        </div>
                                     </div>
                                  </div>
                               </>
                            );
                         })()}
                      </div>

                    </>
                  )}
                  </div>
                  {activeNode && !videoError && (
                  <div className="shrink-0 px-4 py-3 bg-slate-950/95 backdrop-blur-sm border-t border-slate-800">
                      {loopRange && (
                         <div className="flex items-center gap-2 mb-2.5 w-fit bg-amber-400/15 border border-amber-400/40 text-amber-300 px-2.5 py-1 rounded-full text-[11px] font-bold">
                            <span className="animate-pulse">🔁</span>
                            <span className="tabular-nums">Looping {formatClock(loopRange.start)} – {formatClock(loopRange.end)}</span>
                            <button onClick={() => setLoopRange(null)} className="ml-0.5 hover:text-white transition-colors" title="Stop looping"><X size={12}/></button>
                         </div>
                      )}
                      <div className="relative w-full h-1 bg-slate-700 rounded-full cursor-pointer mb-3" onClick={handleSeek}>
                         <div className="absolute top-0 left-0 h-full bg-sky-400 rounded-full pointer-events-none" style={{ width: `${(currentTime / duration) * 100}%` }}/>
                         {topLevelComments.map(c => (
                            c.end_seconds != null && c.end_seconds > (c.timestamp_seconds || 0) ? (
                               <div
                                  key={c.id}
                                  title={`${formatClock(c.timestamp_seconds)} – ${formatClock(c.end_seconds)}`}
                                  className={`absolute top-1/2 -translate-y-1/2 h-2 rounded-full z-20 cursor-pointer transition-all hover:brightness-125 ${loopRange && Math.abs(loopRange.start - (c.timestamp_seconds || 0)) < 0.01 ? 'bg-amber-400 ring-2 ring-amber-300/60' : 'bg-rose-500/90'}`}
                                  style={{ left: `${((c.timestamp_seconds || 0) / duration) * 100}%`, width: `${Math.max(((c.end_seconds - (c.timestamp_seconds || 0)) / duration) * 100, 1.2)}%` }}
                                  onClick={(e) => handleMarkerClick(e, c.id, c.timestamp_seconds)}
                               />
                            ) : (
                               <div key={c.id} className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-rose-500 rounded-full z-20 transition-transform hover:scale-150 cursor-pointer" style={{ left: `${((c.timestamp_seconds || 0) / duration) * 100}%` }} onClick={(e) => handleMarkerClick(e, c.id, c.timestamp_seconds)}/>
                            )
                         ))}
                         {/* Live pending-range marker while creating a spatial range */}
                         {pendingRange && (
                            pendingRange.end != null ? (
                               <div className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full bg-amber-400 ring-2 ring-amber-300/70 z-30 pointer-events-none animate-pulse" style={{ left: `${(pendingRange.start / duration) * 100}%`, width: `${Math.max(((pendingRange.end - pendingRange.start) / duration) * 100, 1.2)}%` }} />
                            ) : (
                               <>
                                  {currentTime > pendingRange.start && (
                                     <div className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full bg-amber-400/40 z-20 pointer-events-none" style={{ left: `${(pendingRange.start / duration) * 100}%`, width: `${((Math.min(currentTime, duration) - pendingRange.start) / duration) * 100}%` }} />
                                  )}
                                  <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-amber-400 rounded-full border-2 border-white z-30 pointer-events-none animate-pulse" style={{ left: `${(pendingRange.start / duration) * 100}%` }} />
                               </>
                            )
                         )}
                      </div>

                      <div className="flex items-center justify-between text-slate-200">
                         <div className="flex items-center gap-3">
                            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, currentTime - 5); }} className="text-slate-400 hover:text-white transition-colors p-1.5" title="Skip back 5s">
                               <SkipBack size={18} fill="currentColor"/>
                            </button>
                            <button onClick={togglePlay} className="text-white transition-colors p-1.5" title={isPlaying ? 'Pause' : 'Play'}>
                               {isPlaying ? <Pause size={22} fill="currentColor"/> : <Play size={22} fill="currentColor"/>}
                            </button>
                            <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min(duration, currentTime + 5); }} className="text-slate-400 hover:text-white transition-colors p-1.5" title="Skip forward 5s">
                               <SkipForward size={18} fill="currentColor"/>
                            </button>
                            <button type="button" title="Click to copy current timecode" onClick={async () => { const ts = formatTimestamp(currentTime); try { await navigator.clipboard.writeText(ts); } catch { const el = document.createElement('textarea'); el.value = ts; el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(el); el.focus(); el.select(); document.execCommand('copy'); document.body.removeChild(el); } setCopiedTimestampId('controlbar'); setTimeout(() => setCopiedTimestampId(null), 1500); }} className={`text-xs font-bold tabular-nums ml-2 transition-all px-1.5 py-0.5 rounded ${copiedTimestampId === 'controlbar' ? 'bg-emerald-500 text-white' : 'text-slate-300 hover:text-white hover:bg-white/10'}`}>{copiedTimestampId === 'controlbar' ? '✓ COPIED' : formatTimestamp(currentTime)}</button><span className="opacity-50 mx-1 text-slate-500">/</span><span className="text-xs font-bold tabular-nums text-slate-500">{formatTimestamp(duration)}</span>
                         </div>

                         <div className="flex items-center gap-3">
                            <div className="flex items-center bg-slate-800 border border-slate-700 rounded-md overflow-hidden">
                               <button
                                  onClick={() => { const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]; setPlaybackRate(prev => { const i = STEPS.indexOf(prev); return i > 0 ? STEPS[i - 1] : prev; }); }}
                                  className="px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-30"
                                  disabled={playbackRate <= 0.25}
                                  title="Slow down (↓ / K)"
                               >
                                  <Minus size={13} />
                               </button>
                               <select
                                  value={playbackRate}
                                  onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                                  className="bg-transparent text-slate-200 text-xs font-bold px-1 py-1 outline-none hover:bg-slate-700 transition-colors cursor-pointer text-center appearance-none"
                                  title="Playback speed"
                               >
                                  <option value={0.25}>0.25x</option>
                                  <option value={0.5}>0.50x</option>
                                  <option value={0.75}>0.75x</option>
                                  <option value={1}>1x</option>
                                  <option value={1.25}>1.25x</option>
                                  <option value={1.5}>1.50x</option>
                                  <option value={2}>2x</option>
                                  <option value={3}>3x</option>
                                  <option value={4}>4x</option>
                               </select>
                               <button
                                  onClick={() => { const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]; setPlaybackRate(prev => { const i = STEPS.indexOf(prev); return i < STEPS.length - 1 ? STEPS[i + 1] : prev; }); }}
                                  className="px-2 py-1 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors disabled:opacity-30"
                                  disabled={playbackRate >= 4}
                                  title="Speed up (↑ / L)"
                               >
                                  <Plus size={13} />
                               </button>
                            </div>
                            <button onClick={toggleMute} className="text-slate-300 hover:text-white transition-colors p-1.5" title={isMuted ? 'Unmute' : 'Mute'}>{isMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
                            {isCompareMode && <div className="px-2 py-0.5 bg-slate-800 rounded text-[10px] font-bold text-slate-300 border border-slate-700">V{nodes.findIndex(n => n.id === activeNodeId) + 1}</div>}
                            <button onClick={toggleFullscreen} className="text-slate-300 hover:text-white transition-colors p-1.5" title="Fullscreen"><Maximize2 size={17} /></button>
                         </div>
                      </div>
                  </div>
                  )}
               </div>

               {isCompareMode && compareNode && (
                   <div className="flex-1 flex flex-col min-h-0 min-w-0">
                      <div className="flex-1 bg-black group shadow-2xl ring-1 ring-black/10 min-h-0 flex flex-col">
                         <div className="flex-1 relative overflow-hidden min-h-0">
                           <video
                             key={compareStreamUrl}
                             ref={compareVideoRef}
                             src={compareStreamUrl}
                             className="absolute inset-0 w-full h-full object-contain"
                             onTimeUpdate={handleCompareTimeUpdate}
                             onLoadedMetadata={() => setCompareDuration(compareVideoRef.current?.duration || 0)}
                             onPlay={() => setCompareIsPlaying(true)}
                             onPause={() => setCompareIsPlaying(false)}
                             playsInline
                             muted={compareIsMuted}
                           />
                           <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-lg text-[11px] font-black text-white uppercase tracking-widest border border-white/10">
                               Version {nodes.findIndex(n => n.id === compareNodeId) + 1}
                           </div>

                           <div className="absolute inset-0 cursor-crosshair" onClick={handleCompareVideoClick} onContextMenu={(e) => e.preventDefault()} onMouseDown={handleCompareVideoMouseDown}>
                              {isDrawingRect && rectDraft && popoverTarget === 'compare' && (() => {
                                 const rx1 = Math.min(rectDraft.x1, rectDraft.x2); const ry1 = Math.min(rectDraft.y1, rectDraft.y2);
                                 const rw = Math.abs(rectDraft.x2 - rectDraft.x1); const rh = Math.abs(rectDraft.y2 - rectDraft.y1);
                                 return (<div className="absolute border-2 border-emerald-400 bg-emerald-400/10 pointer-events-none z-10" style={{ left: `${rx1}%`, top: `${ry1}%`, width: `${rw}%`, height: `${rh}%` }}>
                                   <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                   <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                   <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                   <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                 </div>);
                              })()}
                              {pendingAnnotation && popoverTarget === 'compare' && (
                                pendingAnnotation.rect ? (
                                  <div className="absolute border-2 border-emerald-400 bg-emerald-400/10 pointer-events-none z-10" style={{ left: `${pendingAnnotation.rect.x1}%`, top: `${pendingAnnotation.rect.y1}%`, width: `${pendingAnnotation.rect.x2 - pendingAnnotation.rect.x1}%`, height: `${pendingAnnotation.rect.y2 - pendingAnnotation.rect.y1}%` }}>
                                    <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                  </div>
                                ) : (
                                  <div className="absolute w-8 h-8 -ml-4 -mt-4 bg-emerald-500 rounded-full border-4 border-white shadow-xl animate-bounce pointer-events-none z-10 flex items-center justify-center text-white" style={{ left: `${pendingAnnotation.x}%`, top: `${pendingAnnotation.y}%` }}><span className="w-2 h-2 bg-white rounded-full"></span></div>
                                )
                              )}
                              {visibleCompareAnnotation && visibleCompareAnnotation.annotation && (
                                visibleCompareAnnotation.annotation.rect ? (
                                  <div className="absolute border-2 border-emerald-400 bg-emerald-400/10 pointer-events-none z-10" style={{ left: `${visibleCompareAnnotation.annotation.rect.x1}%`, top: `${visibleCompareAnnotation.annotation.rect.y1}%`, width: `${visibleCompareAnnotation.annotation.rect.x2 - visibleCompareAnnotation.annotation.rect.x1}%`, height: `${visibleCompareAnnotation.annotation.rect.y2 - visibleCompareAnnotation.annotation.rect.y1}%` }}>
                                    <div className="absolute -left-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -right-1.5 -top-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -left-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                    <div className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-black rounded-full border-2 border-emerald-400"/>
                                  </div>
                                ) : (
                                  <div className="absolute w-8 h-8 -ml-4 -mt-4 bg-emerald-500 rounded-full border-4 border-white shadow-xl pointer-events-none z-10 flex items-center justify-center text-white transition-all duration-300" style={{ left: `${visibleCompareAnnotation.annotation.x}%`, top: `${visibleCompareAnnotation.annotation.y}%` }}><span className="w-2 h-2 bg-white rounded-full"></span></div>
                                )
                              )}
                           </div>
                         </div>

                         <div className="shrink-0 p-4 bg-black/80 border-t border-white/10">
                             <div className="relative w-full h-2 bg-white dark:bg-slate-800/30 rounded-full cursor-pointer mb-4" onClick={handleCompareSeek}>
                                <div className="absolute top-0 left-0 h-full bg-emerald-400 rounded-full pointer-events-none" style={{ width: `${compareDuration > 0 ? (compareCurrentTime / compareDuration) * 100 : 0}%` }} />
                                {compareComments.map(c => (
                                   <div key={c.id} className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-rose-50 dark:bg-rose-500/100 rounded-full border border-white z-20 transition-transform hover:scale-150" style={{ left: `${((c.timestamp_seconds || 0) / compareDuration) * 100}%` }} onClick={(e) => handleMarkerClick(e, c.id, c.timestamp_seconds)}/>
                                ))}
                             </div>
                             <div className="flex items-center justify-between text-white">
                                <div className="flex items-center gap-6">
                                   <button onClick={toggleComparePlay} className="hover:text-emerald-400 transition-colors">
                                      {compareIsPlaying ? <Pause size={24} fill="currentColor"/> : <Play size={24} fill="currentColor"/>}
                                   </button>
                                   <button onClick={toggleCompareMute} className="hover:text-emerald-400 transition-colors">{compareIsMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
                                   <span className="text-xs font-black tabular-nums italic tracking-widest text-white/80">{formatTimestamp(compareCurrentTime)} <span className="opacity-50 mx-1">/</span> {formatTimestamp(compareDuration)}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                   <div className="px-2 py-1 bg-black/40 rounded-lg text-[11px] font-black uppercase tracking-widest border border-white/10">V{nodes.findIndex(n => n.id === compareNodeId) + 1}</div>
                                   <button
                                      onClick={() => setSyncEnabled(v => !v)}
                                      title={syncEnabled ? 'Sync on — click to control videos independently' : 'Sync off — click to lock videos together'}
                                      className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 border transition-all active:scale-95 ${syncEnabled ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30' : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10 hover:text-white/80'}`}
                                   >
                                      {syncEnabled ? <CheckCircle2 size={10} /> : <X size={10} />} Sync
                                   </button>
                                </div>
                             </div>
                         </div>
                      </div>
                   </div>
               )}
            </div>

         {isCompareMode && activeNode && (
            <div className="flex gap-4 shrink-0">
               <div className="flex-1 h-[220px] bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-800 rounded-2xl flex flex-col overflow-hidden shadow-sm">
                  <div className="p-3 border-b border-gray-50 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
                     <div className="flex items-center gap-2">
                        <History size={14} className="text-[#3A9BDC]" />
                        <h3 className="text-[11px] font-black text-[#34495E] dark:text-slate-200 uppercase tracking-[0.2em]">FRAME LOG</h3>
                     </div>
                     <div className="flex items-center gap-1.5">
                        <button onClick={() => frameLogScrollRef.current?.scrollBy({ top: -80, behavior: 'smooth' })} className="p-0.5 rounded text-gray-400 hover:text-[#3A9BDC] hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors"><ChevronUp size={14} /></button>
                        <button onClick={() => frameLogScrollRef.current?.scrollBy({ top: 80, behavior: 'smooth' })} className="p-0.5 rounded text-gray-400 hover:text-[#3A9BDC] hover:bg-sky-50 dark:hover:bg-sky-500/10 transition-colors"><ChevronDown size={14} /></button>
                        <Badge colorClass="bg-sky-50 dark:bg-sky-500/10 text-indigo-600 dark:text-indigo-400 border-none">V{nodes.findIndex(n => n.id === activeNodeId) + 1}</Badge>
                     </div>
                  </div>
                  <div ref={frameLogScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide bg-[#fcfcfe] dark:bg-slate-900">
                     {comments.length === 0 ? (
                        <div className="py-6 text-center opacity-30 italic text-[11px] font-black uppercase tracking-widest">No frame markers.</div>
                     ) : comments.map(c => (
                        <div key={c.id} id={`comment-${c.id}`} onClick={() => { setActiveCommentId(c.id); jumpToTime(c.timestamp_seconds); }} className={`p-2 rounded-xl border shadow-sm transition-all cursor-pointer ${activeCommentId === c.id ? 'border-[#3A9BDC] bg-sky-50 dark:bg-sky-500/10 ring-1 ring-[#3A9BDC]/40' : Math.abs(currentTime - (c.timestamp_seconds || 0)) < 0.5 ? 'border-[#3A9BDC] bg-sky-50 dark:bg-sky-500/10' : 'border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-800 hover:border-[#3A9BDC]/30'}`}>
                           <div className="flex items-center gap-2">
                              <div className="w-5 h-5 rounded-full bg-sky-100 flex items-center justify-center overflow-hidden border border-white shrink-0">{c.profiles?.avatar_url ? <img src={c.profiles.avatar_url} className="w-full h-full object-cover" /> : <div className="text-[10px] font-black text-[#3A9BDC]">{c.profiles?.full_name?.charAt(0) || 'U'}</div>}</div>
                              <button type="button" title="Click to copy timestamp" onClick={async (e) => { e.stopPropagation(); const ts = formatTimestamp(c.timestamp_seconds); try { await navigator.clipboard.writeText(ts); } catch { const el = document.createElement('textarea'); el.value = ts; el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(el); el.focus(); el.select(); document.execCommand('copy'); document.body.removeChild(el); } setCopiedTimestampId(c.id); setTimeout(() => setCopiedTimestampId(null), 1500); }} className={`tabular-nums px-1.5 py-0.5 font-black text-[9px] tracking-widest shrink-0 rounded border-none transition-all ${copiedTimestampId === c.id ? 'bg-emerald-500 text-white scale-105' : 'bg-[#34495E] text-white hover:bg-[#3A9BDC]'}`}>{copiedTimestampId === c.id ? '✓ COPIED' : formatTimestamp(c.timestamp_seconds)}</button>
                              {c.end_seconds != null && c.end_seconds > c.timestamp_seconds && (
                                 <span title={`Range ${formatClock(c.timestamp_seconds)} – ${formatClock(c.end_seconds)}`} className="tabular-nums px-1.5 py-0.5 font-black text-[9px] tracking-widest shrink-0 rounded bg-rose-500/20 text-rose-500 border border-rose-500/40">↔ {formatClock(c.timestamp_seconds)}–{formatClock(c.end_seconds)}</span>
                              )}
                              {c.content && <p className="text-xs font-medium text-gray-600 dark:text-slate-400 italic truncate flex-1">{c.content}</p>}
                              <button onClick={async (e) => { e.stopPropagation(); await deleteComment(c.id); setComments(prev => prev.filter(x => x.id !== c.id)); }} className="p-1 text-gray-300 hover:text-rose-500 transition-all shrink-0"><Trash2 size={10}/></button>
                           </div>
                        </div>
                     ))}
                  </div>
                  <div className="p-2 border-t border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-800 shrink-0">
                     <div className="flex items-center gap-2 bg-[#f8f9fd] dark:bg-slate-700 border border-gray-100 dark:border-slate-700 p-1.5 pl-3 rounded-xl">
                        <input type="text" value={globalComment} onChange={e => setGlobalComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handlePostGlobalComment(); }} placeholder="Add note..." className="flex-1 bg-transparent border-none outline-none text-xs font-bold text-[#34495E] dark:text-slate-200 placeholder:italic placeholder:font-normal placeholder:text-gray-400" />
                        <button onClick={handlePostGlobalComment} disabled={!globalComment.trim() || isSubmittingGlobal} className="p-2 bg-[#34495E] text-white rounded-lg hover:bg-[#3A9BDC] disabled:opacity-50 transition-all active:scale-95 shadow-sm flex items-center justify-center shrink-0">{isSubmittingGlobal ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}</button>
                     </div>
                  </div>
               </div>
               {compareNode && (
                  <div className="flex-1 h-[220px] bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-800 rounded-2xl flex flex-col overflow-hidden shadow-sm">
                     <div className="p-3 border-b border-gray-50 flex items-center justify-between bg-white dark:bg-slate-800 shrink-0">
                        <div className="flex items-center gap-2">
                           <History size={14} className="text-emerald-500" />
                           <h3 className="text-[11px] font-black text-[#34495E] dark:text-slate-200 uppercase tracking-[0.2em]">FRAME LOG</h3>
                        </div>
                        <div className="flex items-center gap-1.5">
                           <button onClick={() => compareFrameLogScrollRef.current?.scrollBy({ top: -80, behavior: 'smooth' })} className="p-0.5 rounded text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors"><ChevronUp size={14} /></button>
                           <button onClick={() => compareFrameLogScrollRef.current?.scrollBy({ top: 80, behavior: 'smooth' })} className="p-0.5 rounded text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors"><ChevronDown size={14} /></button>
                           <Badge colorClass="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-none">V{nodes.findIndex(n => n.id === compareNodeId) + 1}</Badge>
                        </div>
                     </div>
                     <div ref={compareFrameLogScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide bg-[#fcfcfe] dark:bg-slate-900">
                        {compareComments.length === 0 ? (
                           <div className="py-6 text-center opacity-30 italic text-[11px] font-black uppercase tracking-widest">No frame markers.</div>
                        ) : compareComments.map(c => (
                           <div key={c.id} onClick={() => { if (compareVideoRef.current && c.timestamp_seconds != null) { compareVideoRef.current.currentTime = c.timestamp_seconds; if (videoRef.current) videoRef.current.currentTime = c.timestamp_seconds; } }} className={`p-2 rounded-xl border shadow-sm transition-all cursor-pointer ${Math.abs(compareCurrentTime - (c.timestamp_seconds || 0)) < 0.5 ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10' : 'border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-800 hover:border-emerald-300'}`}>
                              <div className="flex items-center gap-2">
                                 <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center overflow-hidden border border-white shrink-0">{c.profiles?.avatar_url ? <img src={c.profiles.avatar_url} className="w-full h-full object-cover" /> : <div className="text-[10px] font-black text-emerald-600 dark:text-emerald-400">{c.profiles?.full_name?.charAt(0) || 'U'}</div>}</div>
                                 <button type="button" title="Click to copy timestamp" onClick={async (e) => { e.stopPropagation(); const ts = formatTimestamp(c.timestamp_seconds); try { await navigator.clipboard.writeText(ts); } catch { const el = document.createElement('textarea'); el.value = ts; el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(el); el.focus(); el.select(); document.execCommand('copy'); document.body.removeChild(el); } setCopiedTimestampId(c.id); setTimeout(() => setCopiedTimestampId(null), 1500); }} className={`tabular-nums px-1.5 py-0.5 font-black text-[9px] tracking-widest shrink-0 rounded border-none transition-all ${copiedTimestampId === c.id ? 'bg-emerald-500 text-white scale-105' : 'bg-[#34495E] text-white hover:bg-[#3A9BDC]'}`}>{copiedTimestampId === c.id ? '✓ COPIED' : formatTimestamp(c.timestamp_seconds)}</button>
                              {c.end_seconds != null && c.end_seconds > c.timestamp_seconds && (
                                 <span title={`Range ${formatClock(c.timestamp_seconds)} – ${formatClock(c.end_seconds)}`} className="tabular-nums px-1.5 py-0.5 font-black text-[9px] tracking-widest shrink-0 rounded bg-rose-500/20 text-rose-500 border border-rose-500/40">↔ {formatClock(c.timestamp_seconds)}–{formatClock(c.end_seconds)}</span>
                              )}
                                 {c.content && <p className="text-xs font-medium text-gray-600 dark:text-slate-400 italic truncate flex-1">{c.content}</p>}
                                 <button onClick={async (e) => { e.stopPropagation(); await deleteComment(c.id); setCompareComments(prev => prev.filter(x => x.id !== c.id)); }} className="p-1 text-gray-300 hover:text-rose-500 transition-all shrink-0"><Trash2 size={10}/></button>
                              </div>
                           </div>
                        ))}
                     </div>
                     <div className="p-2 border-t border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-800 shrink-0">
                        <div className="flex items-center gap-2 bg-[#f8f9fd] dark:bg-slate-700 border border-gray-100 dark:border-slate-700 p-1.5 pl-3 rounded-xl">
                           <input type="text" value={compareGlobalComment} onChange={e => setCompareGlobalComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handlePostCompareGlobalComment(); }} placeholder="Add note..." className="flex-1 bg-transparent border-none outline-none text-xs font-bold text-[#34495E] dark:text-slate-200 placeholder:italic placeholder:font-normal placeholder:text-gray-400" />
                           <button onClick={handlePostCompareGlobalComment} disabled={!compareGlobalComment.trim() || isSubmittingCompareComment} className="p-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-all active:scale-95 shadow-sm flex items-center justify-center shrink-0">{isSubmittingCompareComment ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}</button>
                        </div>
                     </div>
                  </div>
               )}
            </div>
         )}
         </div>

        {!isSidebarCollapsed && !isCompareMode && (
            <div className="w-full lg:w-[400px] flex flex-col h-full shrink-0 min-h-0 bg-slate-900 border-l border-slate-800">
               <div className="px-5 pt-5 pb-3 shrink-0">
                  <h3 className="text-xl font-bold text-white">Comments</h3>
               </div>
               <div className="px-5 pb-3 flex items-center gap-2 shrink-0">
                  <input
                     type="text"
                     value={commentSearch}
                     onChange={(e) => setCommentSearch(e.target.value)}
                     placeholder="Search comments"
                     className="flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none focus:border-slate-600"
                  />
                  <div className="bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold px-2.5 py-1.5 rounded-md flex items-center gap-1.5">
                     <Check size={12} /> {acknowledgedComments.size} of {topLevelComments.length}
                  </div>
               </div>

               <div className="flex-1 overflow-y-auto px-5 py-2 space-y-4 scrollbar-hide">
                  {filteredTopLevelComments.map((c) => {
                     const tcKey = Math.max(0, Math.floor(c.timestamp_seconds || 0));
                     const thumb = commentThumbs[tcKey];
                     const isActive = Math.abs(currentTime - (c.timestamp_seconds || 0)) < 0.5;
                     const replies = repliesByParent[c.id] || [];
                     return (
                       <div
                          key={c.id}
                          id={`comment-${c.id}`}
                          onClick={() => { setActiveCommentId(c.id); jumpToTime(c.timestamp_seconds); }}
                          className={`pb-4 cursor-pointer group rounded-lg -mx-2 px-2 pt-2 transition-colors border ${activeCommentId === c.id ? 'bg-sky-500/10 border-sky-500/50' : 'border-transparent border-b-slate-800 hover:bg-slate-800/40'}`}
                       >
                          {/* Prominent timecode at the top of the comment */}
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                             <button type="button" title="Click to copy timecode" onClick={async (e) => { e.stopPropagation(); const ts = formatTimestamp(c.timestamp_seconds); try { await navigator.clipboard.writeText(ts); } catch { const el = document.createElement('textarea'); el.value = ts; el.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(el); el.focus(); el.select(); document.execCommand('copy'); document.body.removeChild(el); } setCopiedTimestampId(c.id); setTimeout(() => setCopiedTimestampId(null), 1500); }} className={`tabular-nums px-2.5 py-1 font-black text-sm tracking-wider rounded-lg transition-all ${copiedTimestampId === c.id ? 'bg-emerald-500 text-white' : 'bg-[#34495E] text-white hover:bg-[#3A9BDC]'}`}>{copiedTimestampId === c.id ? '✓ COPIED' : formatTimestamp(c.timestamp_seconds)}</button>
                             {c.end_seconds != null && c.end_seconds > c.timestamp_seconds && (
                                <span title={`Range ${formatClock(c.timestamp_seconds)} – ${formatClock(c.end_seconds)}`} className="tabular-nums px-2 py-1 font-black text-xs tracking-wider rounded-lg bg-rose-500/20 text-rose-500 border border-rose-500/40">↔ {formatClock(c.timestamp_seconds)}–{formatClock(c.end_seconds)}</span>
                             )}
                          </div>
                          <div className="flex items-start justify-between mb-2">
                             <div className="flex items-center gap-2 min-w-0">
                                <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center overflow-hidden shrink-0">
                                   {c.profiles?.avatar_url ? <img src={c.profiles.avatar_url} className="w-full h-full object-cover" /> : <div className="text-xs font-bold text-white">{c.profiles?.full_name?.charAt(0).toUpperCase() || 'U'}</div>}
                                </div>
                                <div className="min-w-0 flex-1">
                                   <p className="text-sm font-semibold text-slate-100 truncate leading-none">{c.profiles?.full_name || 'System'}</p>
                                   <p className="text-[11px] text-slate-500 mt-1">{new Date(c.created_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</p>
                                </div>
                             </div>
                             <div className="flex items-center gap-1">
                                {c.annotation && <span className="text-[9px] font-bold text-rose-400 uppercase">Marker</span>}
                                {c.user_id === user.id && (
                                   <button onClick={(e) => { e.stopPropagation(); startEdit(c); }} className="p-1 text-slate-500 hover:text-sky-400 transition-colors" title="Edit comment"><Pencil size={13}/></button>
                                )}
                                <button onClick={async (e) => { e.stopPropagation(); await deleteComment(c.id); setComments(prev => prev.filter(x => x.id !== c.id)); }} className="p-1 text-slate-500 hover:text-rose-400 transition-colors" title="Delete comment"><Trash2 size={14}/></button>
                             </div>
                          </div>

                          <div className="flex items-start gap-2 mb-2">
                             {thumb ? (
                                <div className="relative w-20 h-12 rounded-md overflow-hidden border border-slate-700 bg-black shrink-0">
                                   <img src={thumb} alt="frame" className="w-full h-full object-cover" />
                                </div>
                             ) : (
                                <div className="w-20 h-12 rounded-md border border-slate-700 bg-slate-800 shrink-0 flex items-center justify-center">
                                   <Video size={16} className="text-slate-500" />
                                </div>
                             )}
                             <div className="flex-1 min-w-0">
                                {editingCommentId === c.id ? (
                                   <div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                                      <div className="flex items-start gap-1">
                                         <textarea autoFocus value={editingCommentText} onChange={(e) => setEditingCommentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(c.id); } if (e.key === 'Escape') { cancelEdit(); } }} rows={Math.min(10, Math.max(3, editingCommentText.split('\n').length + 1))} className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 leading-snug outline-none focus:border-sky-500 resize-y" />
                                         <button onClick={() => handleSaveEdit(c.id)} className="p-1 text-sky-400 hover:text-sky-300 shrink-0" title="Save (Enter)"><Check size={12}/></button>
                                         <button onClick={cancelEdit} className="p-1 text-slate-400 hover:text-slate-200 shrink-0" title="Cancel (Esc)"><X size={12}/></button>
                                      </div>
                                      {renderEditAttachRow(c)}
                                   </div>
                                ) : (
                                   c.content && <p className="text-sm text-slate-200 leading-snug break-words whitespace-pre-wrap">{renderCommentText(c.content)}</p>
                                )}
                                {editingCommentId !== c.id && c.attachment_url && (
                                   <a href={c.attachment_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-md text-[10px] font-semibold hover:bg-slate-700 transition-colors mt-1.5">
                                      <ExternalLink size={9} /> Attachment
                                   </a>
                                )}
                             </div>
                          </div>

                          {expandedReplyId === c.id ? (
                             <div className="bg-slate-800 border border-slate-700 rounded-md p-2 mt-2 flex flex-col gap-2">
                                <input
                                   type="text"
                                   autoFocus
                                   value={replyTexts[c.id] || ''}
                                   onChange={(e) => setReplyTexts(prev => ({ ...prev, [c.id]: e.target.value }))}
                                   onClick={(e) => e.stopPropagation()}
                                   onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostReply(c); } }}
                                   placeholder="Reply to thread..."
                                   className="w-full bg-transparent border-none outline-none text-xs text-slate-200 placeholder:text-slate-500"
                                />
                                {replyAttachments[c.id] && (
                                   <div className="flex items-center gap-2 bg-slate-900 border border-slate-700 text-slate-300 px-2 py-1 rounded text-[10px] font-semibold w-fit">
                                      <Paperclip size={10} />
                                      <span className="truncate max-w-[140px]">{replyAttachments[c.id]?.name}</span>
                                      <button onClick={(e) => { e.stopPropagation(); setReplyAttachments(prev => ({ ...prev, [c.id]: null })); }} className="hover:text-rose-400"><X size={10}/></button>
                                   </div>
                                )}
                                <div className="flex items-center justify-between">
                                   <div className="flex items-center gap-1">
                                      <label onClick={(e) => e.stopPropagation()} className="cursor-pointer p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors">
                                         <Paperclip size={14} />
                                         <input
                                            type="file"
                                            className="hidden"
                                            onChange={(e) => {
                                               if (e.target.files && e.target.files[0]) {
                                                  setReplyAttachments(prev => ({ ...prev, [c.id]: e.target.files![0] }));
                                               }
                                            }}
                                         />
                                      </label>
                                      <button
                                         onClick={(e) => {
                                            e.stopPropagation();
                                            setAcknowledgedComments(prev => {
                                               const next = new Set(prev);
                                               if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                               return next;
                                            });
                                         }}
                                         className={`p-1.5 rounded border transition-colors ${acknowledgedComments.has(c.id) ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-transparent border-slate-700 text-slate-500 hover:text-emerald-400'}`}
                                         title="Resolve"
                                      >
                                         <Check size={12} strokeWidth={3}/>
                                      </button>
                                   </div>
                                   <div className="flex items-center gap-2">
                                      <button onClick={(e) => { e.stopPropagation(); setExpandedReplyId(null); }} className="text-[11px] font-semibold text-slate-400 hover:text-slate-200 px-2 py-1">Cancel</button>
                                      <button
                                         onClick={(e) => { e.stopPropagation(); handlePostReply(c); }}
                                         disabled={(!replyTexts[c.id]?.trim() && !replyAttachments[c.id]) || submittingReplyId === c.id}
                                         className="p-1.5 bg-sky-600 text-white rounded-md hover:bg-sky-500 disabled:opacity-50 transition-colors flex items-center justify-center"
                                         title="Send reply"
                                      >
                                         {submittingReplyId === c.id ? <Loader2 size={12} className="animate-spin"/> : <Send size={12}/>}
                                      </button>
                                   </div>
                                </div>
                             </div>
                          ) : (
                             <div className="flex items-center gap-2 mt-2">
                                <input
                                   type="text"
                                   placeholder="Reply to thread..."
                                   readOnly
                                   onClick={(e) => { e.stopPropagation(); setExpandedReplyId(c.id); }}
                                   onFocus={() => setExpandedReplyId(c.id)}
                                   className="flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none cursor-pointer hover:border-slate-600"
                                />
                                <button
                                   onClick={(e) => {
                                      e.stopPropagation();
                                      setAcknowledgedComments(prev => {
                                         const next = new Set(prev);
                                         if (next.has(c.id)) next.delete(c.id);
                                         else next.add(c.id);
                                         return next;
                                      });
                                   }}
                                   className={`w-7 h-7 flex items-center justify-center rounded-md border transition-colors shrink-0 ${acknowledgedComments.has(c.id) ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-emerald-400'}`}
                                   title="Resolve"
                                >
                                   <Check size={14} strokeWidth={3} />
                                </button>
                             </div>
                          )}

                          {replies.length > 0 && (
                             <div className="mt-3 pl-4 border-l-2 border-slate-800 space-y-3">
                                {replies.map(r => (
                                   <div key={r.id} className="flex items-start gap-2 group/reply">
                                      <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center overflow-hidden shrink-0">
                                         {r.profiles?.avatar_url ? <img src={r.profiles.avatar_url} className="w-full h-full object-cover" /> : <span className="text-[10px] font-bold text-white">{r.profiles?.full_name?.charAt(0).toUpperCase() || 'U'}</span>}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                         <div className="flex items-center gap-2">
                                            <p className="text-xs font-semibold text-slate-200 truncate">{r.profiles?.full_name || 'System'}</p>
                                            <p className="text-[10px] text-slate-500">{new Date(r.created_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}</p>
                                         </div>
                                         {editingCommentId === r.id ? (
                                            <div className="flex flex-col gap-1.5 mt-0.5" onClick={(e) => e.stopPropagation()}>
                                               <div className="flex items-start gap-1">
                                                  <textarea autoFocus value={editingCommentText} onChange={(e) => setEditingCommentText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(r.id); } if (e.key === 'Escape') { cancelEdit(); } }} rows={Math.min(10, Math.max(2, editingCommentText.split('\n').length + 1))} className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-200 leading-snug outline-none focus:border-sky-500 resize-y" />
                                                  <button onClick={() => handleSaveEdit(r.id)} className="p-1 text-sky-400 hover:text-sky-300 shrink-0" title="Save (Enter)"><Check size={11}/></button>
                                                  <button onClick={cancelEdit} className="p-1 text-slate-400 hover:text-slate-200 shrink-0" title="Cancel (Esc)"><X size={11}/></button>
                                               </div>
                                               {renderEditAttachRow(r)}
                                            </div>
                                         ) : (
                                            r.content && <p className="text-xs text-slate-300 leading-snug mt-0.5 break-words whitespace-pre-wrap">{renderCommentText(r.content)}</p>
                                         )}
                                         {editingCommentId !== r.id && r.attachment_url && (
                                            <a href={r.attachment_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-md text-[10px] font-semibold hover:bg-slate-700 transition-colors mt-1">
                                               <ExternalLink size={9} /> Attachment
                                            </a>
                                         )}
                                      </div>
                                      {r.user_id === user.id && (
                                         <button onClick={(e) => { e.stopPropagation(); startEdit(r); }} className="opacity-0 group-hover/reply:opacity-100 p-1 text-slate-500 hover:text-sky-400 transition-all shrink-0" title="Edit"><Pencil size={11}/></button>
                                      )}
                                      <button onClick={async (e) => { e.stopPropagation(); await deleteComment(r.id); setComments(prev => prev.filter(x => x.id !== r.id)); }} className="opacity-0 group-hover/reply:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-all shrink-0"><Trash2 size={11}/></button>
                                   </div>
                                ))}
                             </div>
                          )}
                       </div>
                     );
                  })}
                  {!activeNode && <div className="py-20 text-center text-slate-500 italic text-xs">Awaiting video node.</div>}
                  {activeNode && topLevelComments.length === 0 && <div className="py-20 text-center text-slate-500 italic text-xs">No comments yet.</div>}
               </div>

               {activeNode && (
                  <div className="p-3 border-t border-slate-800 shrink-0 flex flex-col gap-2">
                     {globalAttachmentFile && (
                        <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-md text-[11px] font-semibold w-fit">
                           <Paperclip size={10} />
                           <span className="truncate max-w-[120px]">{globalAttachmentFile.name}</span>
                           <button onClick={() => setGlobalAttachmentFile(null)} className="ml-1 hover:text-rose-400 transition-colors">
                              <X size={12} />
                           </button>
                        </div>
                     )}
                     <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                           type="button"
                           onClick={() => { const t = videoRef.current?.currentTime ?? 0; setRangeStart(t); if (rangeEnd != null && rangeEnd <= t) setRangeEnd(null); }}
                           className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors tabular-nums"
                        >
                           Set start{rangeStart != null ? ` · ${formatClock(rangeStart)}` : ''}
                        </button>
                        <button
                           type="button"
                           disabled={rangeStart == null}
                           onClick={() => { const t = videoRef.current?.currentTime ?? 0; if (rangeStart != null && t > rangeStart) setRangeEnd(t); }}
                           className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors tabular-nums"
                        >
                           Set end{rangeEnd != null ? ` · ${formatClock(rangeEnd)}` : ''}
                        </button>
                        {(rangeStart != null || rangeEnd != null) && (
                           <span className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold bg-rose-500/15 border border-rose-500/40 text-rose-300 tabular-nums">
                              {rangeStart != null && rangeEnd != null
                                 ? `Range ${formatClock(rangeStart)} – ${formatClock(rangeEnd)}`
                                 : `Start ${formatClock(rangeStart)} · set an end`}
                              <button type="button" onClick={() => { setRangeStart(null); setRangeEnd(null); }} className="hover:text-white transition-colors" title="Clear range"><X size={10}/></button>
                           </span>
                        )}
                     </div>
                     <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 p-1.5 pl-3 rounded-md">
                        <label className="cursor-pointer text-slate-400 hover:text-slate-200 transition-colors shrink-0">
                           <Paperclip size={14} />
                           <input
                              type="file"
                              className="hidden"
                              onChange={(e) => {
                                 if (e.target.files && e.target.files[0]) {
                                    setGlobalAttachmentFile(e.target.files[0]);
                                 }
                              }}
                           />
                        </label>
                        <input
                           type="text"
                           value={globalComment}
                           onChange={e => setGlobalComment(e.target.value)}
                           onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handlePostGlobalComment(); }}
                           placeholder="Add a general note..."
                           className="flex-1 bg-transparent border-none outline-none text-xs text-slate-200 placeholder:text-slate-500"
                        />
                        <button
                           onClick={handlePostGlobalComment}
                           disabled={(!globalComment.trim() && !globalAttachmentFile) || isSubmittingGlobal || isUploadingGlobal}
                           className="p-1.5 bg-sky-600 text-white rounded-md hover:bg-sky-500 disabled:opacity-50 transition-colors flex items-center justify-center shrink-0"
                        >
                           {(isSubmittingGlobal || isUploadingGlobal) ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        </button>
                     </div>
                  </div>
               )}
            </div>
        )}

        {!isCompareMode && (
           <div className="w-12 shrink-0 bg-slate-900 border-l border-slate-800 flex flex-col items-center py-3 gap-1">
              <button onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)} className={`p-2 rounded-md transition-colors ${isSidebarCollapsed ? 'text-slate-400 hover:text-white hover:bg-slate-800' : 'text-white bg-slate-800'}`} title="Comments">
                 <MessageSquare size={18} />
              </button>
              {activeNode?.video_url && (
                 <a href={activeNode.video_url} target="_blank" rel="noopener noreferrer" download className="p-2 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" title="Download source">
                    <Download size={18} />
                 </a>
              )}
              {activeNode && (
                 <button onClick={() => setIsShareModalOpen(true)} className="p-2 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" title="Share">
                    <Send size={18} />
                 </button>
              )}
           </div>
        )}
      </div>

      {isPopoverOpen && activeNode && (
         <div
           className="fixed z-[999] bg-white dark:bg-slate-800 rounded-2xl shadow-[0_20px_60px_-15px_rgba(0,0,0,0.5)] border border-gray-100 dark:border-slate-800 p-4 w-72 animate-in zoom-in-95 duration-200 select-none"
           style={{
             left: Math.min(Math.max(popoverPos.x, 8), window.innerWidth - 300),
             top: Math.max(popoverPos.y - 150, 80)
           }}
         >
            <div className="flex justify-between items-center mb-3 cursor-grab active:cursor-grabbing" onMouseDown={handlePopoverDragStart}>
               <h4 className="text-xs font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                 <MessageSquare size={14} /> Add Annotation
               </h4>
               <button onClick={(e) => { e.stopPropagation(); cancelPendingRange(); setRectDraft(null); }} className="text-gray-400 hover:text-rose-500"><X size={14}/></button>
            </div>

            {pendingRange && pendingRange.end == null ? (
               /* Awaiting the end mark: comment box hidden, just capture the end point */
               <div className="space-y-3">
                  <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 leading-relaxed">
                     Start set at <span className="tabular-nums font-black text-rose-500">{formatClock(pendingRange.start)}</span>. Scrub to the end of the segment, then set the end point.
                  </p>
                  <button
                     onClick={handleSetRangeEnd}
                     disabled={currentTime <= pendingRange.start}
                     className="w-full bg-amber-500 text-white px-5 py-2.5 rounded-lg text-[11px] font-black uppercase tracking-widest hover:brightness-110 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2 tabular-nums"
                  >
                     Set End at {formatClock(currentTime)}
                  </button>
                  <button onClick={cancelPendingRange} className="w-full text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-rose-500 transition-colors">Cancel range</button>
               </div>
            ) : (
             <>
            <textarea
              autoFocus
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostComment(); } }}
              placeholder={pendingRange ? "Feedback for this segment..." : "Feedback for this coordinate..."}
              className="w-full bg-[#f8f9fd] dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-xl p-3 text-xs font-medium text-[#34495E] dark:text-slate-200 h-20 resize-none outline-none focus:ring-2 focus:ring-indigo-100 mb-2"
            />

            <div className="flex justify-between items-center bg-[#f8f9fd] dark:bg-slate-700 p-1.5 rounded-lg mb-3 border border-dashed border-gray-200">
                <label className="flex items-center gap-2 cursor-pointer text-[#3A9BDC] hover:brightness-110 px-2 py-1 rounded-md transition-all font-bold text-[11px] uppercase tracking-widest max-w-[180px]">
                    <Paperclip size={12} className="shrink-0" />
                    <span className="truncate">{attachmentFile ? attachmentFile.name : 'Attach File'}</span>
                    <input
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                            if (e.target.files && e.target.files[0]) {
                                setAttachmentFile(e.target.files[0]);
                            }
                        }}
                    />
                </label>
                {attachmentFile && (
                    <button onClick={() => setAttachmentFile(null)} className="text-rose-500 p-1 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md shrink-0">
                        <X size={12} />
                    </button>
                )}
            </div>

            <div className="flex justify-between items-center gap-2">
               {pendingRange
                  ? <span className="text-[10px] font-black uppercase tracking-widest text-rose-500 tabular-nums">Range {formatClock(pendingRange.start)}–{formatClock(pendingRange.end)}</span>
                  : <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 tabular-nums">At {formatTimestamp(currentTime)}</span>}
               <div className="flex items-center gap-2 shrink-0">
                  {!pendingRange && popoverTarget === 'active' && (
                     <button
                        onClick={handleSetRangeStart}
                        title="Mark a segment (start → end) instead of a single point"
                        className="border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-95 transition-all"
                     >
                        Set Start
                     </button>
                  )}
                  <button
                    onClick={handlePostComment}
                    disabled={isSubmitting || isUploading || (!newComment.trim() && !attachmentFile)}
                    className="bg-[#3A9BDC] text-white px-5 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest hover:brightness-110 active:scale-95 disabled:opacity-30 flex items-center gap-2"
                  >
                    {(isSubmitting || isUploading) ? <Loader2 className="animate-spin" size={12} /> : <Send size={12} />}
                    {isUploading ? 'UPLOADING...' : 'SAVE'}
                  </button>
               </div>
            </div>
             </>
            )}
         </div>
      )}

      {isShareModalOpen && (
        <Modal isOpen={true} onClose={() => setIsShareModalOpen(false)} title="Share Cinematic Workflow">
          <div className="space-y-4">
            {/* Guest link section */}
            <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Share2 size={14} className="text-[#3A9BDC]" />
                <span className="text-xs font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">Guest Link (Read-only)</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Anyone with this link can view the workspace and all comments — without an account. They cannot post or make any changes.</p>
              {guestLinkUrl ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
                    <span className="flex-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">{guestLinkUrl}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopyGuestLink}
                      className="flex-1 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all bg-[#3A9BDC] text-white hover:brightness-110"
                    >
                      {guestLinkCopied ? '✓ Copied!' : 'Copy Link'}
                    </button>
                    <button
                      onClick={handleRevokeGuestLink}
                      className="px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-all border border-rose-200 dark:border-rose-500/20"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleGenerateGuestLink}
                  disabled={isGeneratingGuestLink}
                  className="w-full py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isGeneratingGuestLink ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />}
                  Generate Guest Link
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} onConfirm={handleDeleteNode} title="PURGE VIDEO NODE" message="Permanently delete this video node and all its frame-accurate feedback markers?" confirmText="PURGE NOW" confirmColor="bg-rose-600 hover:bg-rose-700" />

      {isSetupMode && (
         <Modal isOpen={true} onClose={() => setIsSetupMode(false)} title="Add Video to Workspace">
            <div className="space-y-6">

               <div>
                  <h4 className="text-xs font-black uppercase text-[#3A9BDC] mb-3 tracking-widest flex items-center gap-2">
                    <ExternalLink size={14} /> Option 1: Link External Video
                  </h4>
                  <div className="flex gap-2">
                     <input
                       value={videoUrlInput}
                       onChange={e => setVideoUrlInput(e.target.value)}
                       placeholder="Paste Google Drive, Dropbox, or Server URL..."
                       className="flex-1 bg-[#f8f9fd] dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:ring-2 focus:ring-[#3A9BDC]/50"
                     />
                     <button
                       onClick={handleSetupNode}
                       disabled={!videoUrlInput.trim() || videoUrlInput.includes('Uploading')}
                       className="bg-[#3A9BDC] text-white px-6 rounded-xl font-black uppercase text-xs hover:brightness-110 disabled:opacity-50 transition-all active:scale-95 shadow-sm whitespace-nowrap"
                     >
                       Attach Link
                     </button>
                  </div>
               </div>

               <div className="flex items-center gap-4 py-2">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-slate-700"></div>
                  <span className="text-[11px] font-black text-gray-400 uppercase tracking-widest">OR</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-slate-700"></div>
               </div>

               <div>
                  <h4 className="text-xs font-black uppercase text-indigo-500 mb-3 tracking-widest flex items-center gap-2">
                    <Video size={14} /> Option 2: Upload to Cloud Vault
                  </h4>
                  {videoUrlInput.includes('Uploading') && (
                    <p className="text-[11px] font-bold text-amber-600 italic mb-2">Keep this tab visible until the upload completes.</p>
                  )}
                  <input
                    type="file"
                    accept="video/*"
                    onChange={async (e) => {
                       const file = e.target.files?.[0];
                       if (!file) return;

                       const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
                       if (file.size > MAX_SIZE) {
                         alert('Max 10GB allowed per asset.');
                         return;
                       }

                       setLoading(true);
                       setVideoUrlInput('Authorizing cloud upload...');
                       try {
                         let switchedToUploading = false;
                         const { publicUrl } = await uploadAssetToR2(file, file.name, {
                           onProgress: (pct) => {
                             if (!switchedToUploading) {
                               switchedToUploading = true;
                               setVideoUrlInput('Uploading to R2 Cloud...');
                             }
                           },
                         });

                         setVideoUrlInput('Registering node...');

                         // The file is already in R2 (presigned PUT works in both
                         // modes); recording the node goes through the server action
                         // so it works in the iframe too.
                         const data = await createNode(workflow.id, publicUrl);
                         setNodes(prev => [...prev, data]);
                         setActiveNodeId(data.id);
                         setIsSetupMode(false);
                         setVideoUrlInput('');
                       } catch (err: any) {
                         alert(err.message);
                         setVideoUrlInput('');
                       } finally {
                         setLoading(false);
                       }
                    }}
                    className="w-full bg-[#f8f9fd] dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl p-4 text-xs font-bold text-gray-500 cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-black file:uppercase file:tracking-widest file:bg-indigo-50 dark:bg-indigo-500/10 file:text-indigo-600 dark:text-indigo-400 hover:file:bg-indigo-100 transition-all"
                  />
                  <div className="text-center">
                    {loading && <div className="mt-4 flex flex-col items-center gap-2">
                       <Loader2 className="animate-spin text-indigo-500" size={24} />
                       <p className="text-[11px] font-black uppercase tracking-widest text-indigo-500">{videoUrlInput}</p>
                    </div>}
                  </div>
               </div>
            </div>
         </Modal>
      )}
    </div>
  );
};
