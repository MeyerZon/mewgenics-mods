// The one list of scaffold kinds new_from_template / POST /api/template accept (templates.ts implements them).
// Pure (no Node built-ins): the zod body schema (api-schemas.ts) builds its enum from it and the web UI's
// template modal imports it for the kind dropdown, so a new kind shows up everywhere at once.

export const TEMPLATE_KINDS = ["ability", "passive", "item", "status-data", "room", "tileset-variant", "particle", "vfx-ability", "glowing-character"] as const;

export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
