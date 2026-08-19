/*
 * Cupertino TCC spike — the assumption the whole app-hosted design rests on.
 *
 * ## The question
 *
 * `native/launcher.c` exists because macOS attributes file access to a
 * process's *responsible process*, which for an MCP server is whatever host
 * spawned it — VS Code, Terminal, Claude. It escapes that with the private
 * `responsibility_spawnattrs_setdisclaim` SPI.
 *
 * An ordinary signed `.app` does not need to escape anything: it IS its own
 * responsible process, and so is everything beneath it. If that holds, the
 * SPI can be deleted rather than moved into the bundle.
 *
 * This binary answers two halves of that separately, because they can fail
 * independently:
 *
 *   1. Does the app itself hold Full Disk Access?           (access(2), in-process)
 *   2. Do processes it spawns inherit that access?          (Resources/spike.sh)
 *
 * Half 2 is the one that matters — the real design never reads Mail from
 * Swift, it reads it from a `node` child.
 *
 * ## Why access(2) and never stat(2)
 *
 * `stat` SUCCEEDS on a TCC-protected file: you get the real size and mtime,
 * and only `open`/`access` are denied. A stat-based check reports success and
 * proves nothing. This is the same distinction `packages/core/src/fs.ts`
 * encodes as exists-vs-readable.
 *
 * Built by build.sh, which bakes LOG_PATH in at compile time.
 */

#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#ifndef LOG_PATH
#error "LOG_PATH must be baked in at compile time (see build.sh)"
#endif

static FILE *logf = NULL;

/* Everything goes to both stdout and the log: stdout is useful when the bundle
 * is run from a shell, and it goes nowhere when Finder launches it. */
static void say(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stdout, fmt, ap);
  fputc('\n', stdout);
  va_end(ap);
  if (logf) {
    va_start(ap, fmt);
    vfprintf(logf, fmt, ap);
    fputc('\n', logf);
    va_end(ap);
    fflush(logf);
  }
}

/* Strip n trailing path components in place. */
static void dirname_n(char *path, int n) {
  for (int i = 0; i < n; i++) {
    char *slash = strrchr(path, '/');
    if (!slash) return;
    *slash = '\0';
  }
}

int main(void) {
  logf = fopen(LOG_PATH, "a");

  time_t now = time(NULL);
  char stamp[64];
  strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S%z", localtime(&now));
  say("");
  say("=== cupertino tcc spike @ %s ===", stamp);

  char self[4096];
  uint32_t size = sizeof self;
  if (_NSGetExecutablePath(self, &size) != 0) {
    say("FAIL  could not resolve own executable path");
    return 1;
  }
  say("exec  %s", self);

  /* .../Cupertino Spike.app/Contents/MacOS/cupertino-spike -> the bundle root */
  char bundle[4096];
  snprintf(bundle, sizeof bundle, "%s", self);
  dirname_n(bundle, 3);
  say("app   %s", bundle);

  const char *home = getenv("HOME");
  if (!home) {
    say("FAIL  HOME is unset");
    return 1;
  }

  /* --- Half 1: does the app itself hold Full Disk Access? --- */
  char index_path[4096];
  snprintf(index_path, sizeof index_path, "%s/Library/Mail/V10/MailData/Envelope Index", home);

  int self_readable = access(index_path, R_OK) == 0;
  int self_errno = self_readable ? 0 : errno;
  say("half1 app reads Envelope Index: %s%s%s", self_readable ? "YES" : "NO",
      self_readable ? "" : " — errno=", self_readable ? "" : strerror(self_errno));

  /* --- Half 2: do spawned children inherit it? --- */
  char script[4096];
  snprintf(script, sizeof script, "%s/Contents/Resources/spike.sh", bundle);
  say("half2 spawning %s", script);

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_addopen(&fa, STDOUT_FILENO, LOG_PATH,
                                   O_WRONLY | O_APPEND | O_CREAT, 0644);
  posix_spawn_file_actions_adddup2(&fa, STDOUT_FILENO, STDERR_FILENO);

  char *argv[] = {(char *)"/bin/sh", script, NULL};
  pid_t pid;
  int rc = posix_spawn(&pid, "/bin/sh", &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);

  if (rc != 0) {
    say("FAIL  could not spawn the child probe: %s", strerror(rc));
    return 1;
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) {
      say("FAIL  waitpid: %s", strerror(errno));
      return 1;
    }
  }
  int child_rc = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  say("half2 child probe exited %d", child_rc);
  say("=== end; full log at %s ===", LOG_PATH);

  if (logf) fclose(logf);
  return self_readable && child_rc == 0 ? 0 : 3;
}
