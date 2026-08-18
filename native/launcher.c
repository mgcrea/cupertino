/*
 * apple-mail-mcp launcher — gives the MCP server its own Full Disk Access
 * identity instead of borrowing the host application's.
 *
 * ## Why this exists
 *
 * macOS attributes a process's file access to its *responsible process*, which
 * is normally the app bundle at the top of the launch chain. When Claude spawns
 * the server, that is Visual Studio Code (or Terminal, or Claude.app), so the
 * only way to let the server read Mail's index would be to grant Full Disk
 * Access to the entire editor — and with it, every extension and shell command
 * that editor ever runs.
 *
 * `responsibility_spawnattrs_setdisclaim` makes a spawned child its own
 * responsible process. This launcher re-execs *itself* disclaimed, then spawns
 * node beneath that copy, so the whole subtree is attributed to THIS binary.
 * You grant Full Disk Access to this one file and nothing else.
 *
 * Verified on macOS 26.6: the disclaimed copy reads Mail's Envelope Index, a
 * node child of it inherits that access, and plain node under the same shell
 * stays denied.
 *
 * ## Why it is not a generic "run X with FDA" wrapper
 *
 * That would be a privilege-escalation gadget: any local process could invoke
 * it to read ~/Library/Messages, Safari's history, or anything else, using a
 * permission the user granted for mail. So NODE_PATH and SERVER_PATH are
 * compiled in at install time and argv is never consulted for what to execute.
 * The binary can do exactly one thing.
 *
 * Built and installed by scripts/install-wrapper.sh.
 */

#include <dlfcn.h>
#include <errno.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#ifndef NODE_PATH
#error "NODE_PATH must be baked in at compile time (see scripts/install-wrapper.sh)"
#endif
#ifndef SERVER_PATH
#error "SERVER_PATH must be baked in at compile time (see scripts/install-wrapper.sh)"
#endif

#define INNER_FLAG "--__disclaimed_inner"

typedef int (*disclaim_fn)(posix_spawnattr_t *, int);

static pid_t child_pid = 0;

/* Claude terminates the server by signalling this process; pass it on so node
 * shuts down cleanly rather than being orphaned. */
static void forward_signal(int sig) {
  if (child_pid > 0) kill(child_pid, sig);
}

/* Run the server. stdio is inherited, so the MCP JSON-RPC stream flows through
 * untouched — this process only waits and relays the exit status.
 *
 * Note we SPAWN node rather than exec'ing it: exec would replace this image,
 * and TCC would then evaluate the permission against node's binary rather than
 * ours, putting the grant back on a shared executable. */
static int run_server(void) {
  char *argv[] = {(char *)NODE_PATH, (char *)SERVER_PATH, NULL};

  int rc = posix_spawn(&child_pid, NODE_PATH, NULL, NULL, argv, environ);
  if (rc != 0) {
    fprintf(stderr, "[apple-mail-mcp] cannot start %s: %s\n", NODE_PATH, strerror(rc));
    return 127;
  }

  signal(SIGTERM, forward_signal);
  signal(SIGINT, forward_signal);
  signal(SIGHUP, forward_signal);

  int status = 0;
  while (waitpid(child_pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

int main(int argc, char **argv) {
  /* Second stage: we are the disclaimed copy, so we are our own responsible
   * process and hold whatever Full Disk Access was granted to this binary. */
  if (argc > 1 && strcmp(argv[1], INNER_FLAG) == 0) return run_server();

  disclaim_fn set_disclaim =
      (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");

  /* Degrade rather than die. Without disclaim the server still runs; it just
   * inherits the host's permissions, which means the AppleScript lane works and
   * the search lane reports itself unavailable with a real explanation. */
  if (!set_disclaim) {
    fprintf(stderr,
            "[apple-mail-mcp] responsibility_spawnattrs_setdisclaim is unavailable on this "
            "macOS; starting without an independent Full Disk Access identity. The search "
            "and body lanes will report themselves unavailable.\n");
    return run_server();
  }

  posix_spawnattr_t attrs;
  if (posix_spawnattr_init(&attrs) != 0 || set_disclaim(&attrs, 1) != 0) {
    fprintf(stderr, "[apple-mail-mcp] could not set up the disclaimed spawn; continuing without it.\n");
    return run_server();
  }

  char self[4096];
  uint32_t size = sizeof self;
  if (_NSGetExecutablePath(self, &size) != 0) {
    fprintf(stderr, "[apple-mail-mcp] could not resolve own path; continuing without disclaim.\n");
    posix_spawnattr_destroy(&attrs);
    return run_server();
  }

  char *inner_argv[] = {self, (char *)INNER_FLAG, NULL};
  pid_t pid;
  int rc = posix_spawn(&pid, self, NULL, &attrs, inner_argv, environ);
  posix_spawnattr_destroy(&attrs);
  if (rc != 0) {
    fprintf(stderr, "[apple-mail-mcp] disclaimed spawn failed (%s); continuing without it.\n",
            strerror(rc));
    return run_server();
  }

  child_pid = pid;
  signal(SIGTERM, forward_signal);
  signal(SIGINT, forward_signal);
  signal(SIGHUP, forward_signal);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;

  (void)argc;
}
