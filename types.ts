// Shared types for the Cinematic Workflow app. Client-safe (no server-only
// imports), so both server and client modules can use them.

/**
 * The current user, as the UI needs it. Resolved server-side per run mode (see
 * lib/user.ts) and passed into the client app. No role/ACL fields — every
 * authenticated user is a manager in this app.
 */
export interface User {
  id: string
  full_name: string
  avatar_url: string | null
  email: string | null
}

export interface CinematicWorkflow {
  id: string
  title: string
  description?: string | null
  created_by?: string | null
  created_at: string
  // PostgREST embed of the creator's display name (workflows.created_by -> profiles).
  profiles?: { full_name: string | null } | null
}

export interface CinematicNode {
  id: string
  workflow_id: string
  video_url: string
  created_at: string
}

/**
 * A spatial pin ({x,y}) plus an optional drawn rectangle, stored as jsonb on
 * comments.annotation. The rectangle is two corners in x1/y1/x2/y2 percentages —
 * the exact shape the workspace reads from and writes to the DB.
 */
export interface Annotation {
  x: number
  y: number
  rect?: { x1: number; y1: number; x2: number; y2: number }
}

export interface CinematicComment {
  id: string
  node_id: string
  user_id: string | null
  parent_id: string | null
  content: string
  timestamp_seconds: number
  end_seconds: number | null
  annotation: Annotation | null
  attachment_url: string | null
  created_at: string
  // PostgREST embed (comments.user_id -> profiles).
  profiles?: { full_name: string | null; avatar_url: string | null } | null
}

/**
 * Return shape of the public guest RPC `get_shared_workflow(token)`. Deliberately
 * withholds internal ids — comment authors arrive as name + avatar only. See
 * supabase/migrations/20260721000100_cinematic_workflow_guest_rpc.sql.
 */
export interface SharedComment {
  id: string
  node_id: string
  parent_id: string | null
  content: string
  timestamp_seconds: number
  end_seconds: number | null
  annotation: Annotation | null
  attachment_url: string | null
  created_at: string
  author_name: string | null
  author_avatar: string | null
}

export interface SharedWorkflowPayload {
  workflow: { id: string; title: string; description: string | null; created_at: string } | null
  nodes: { id: string; video_url: string; created_at: string }[]
  comments: SharedComment[]
}
