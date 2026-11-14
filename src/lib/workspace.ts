import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspace } from "./workspace-core";

export * from "./workspace-core";

/** One workspace per request, shared by the layout and the page. */
export const getWorkspace = cache(async () => buildWorkspace(await createClient()));
