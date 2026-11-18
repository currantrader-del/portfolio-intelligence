/**
 * What a server action used with <ActionForm> returns. `{ error }` is a plain-language message shown
 * beside the form, with the person's input kept. Returning nothing (or redirecting) means it worked.
 *
 * Return validation problems instead of throwing them: production builds hide thrown messages.
 */
export type ActionResult = { error: string } | void;

export const fail = (error: string): ActionResult => ({ error });
