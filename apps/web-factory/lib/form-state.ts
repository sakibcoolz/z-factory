/** What a form action answers: a notice, or an error to show next to the form. */
export type FormState = { error?: string; notice?: string };
export const EMPTY_FORM_STATE: FormState = {};
