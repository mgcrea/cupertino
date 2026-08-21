// The `Env` interface is NOT here. `wrangler types` derives it from the bindings
// and vars in wrangler.jsonc — and from the key names in .dev.vars for the
// secrets — into worker-configuration.d.ts, where it is ambient and needs no
// import. Hand-maintaining it meant a second place to forget a binding.
//
// One consequence worth knowing: because the secret names come from .dev.vars,
// which is gitignored, regenerating on a machine without one silently drops them
// from `Env` and typecheck then fails on every `env.LICENSE_SIGNING_KEY`. Copy
// .dev.vars.example first. That is why the generated file is committed rather
// than rebuilt on demand.

export interface LicenseRow {
  id: string;
  email: string;
  key: string;
  last_sent_at: string | null;
}
