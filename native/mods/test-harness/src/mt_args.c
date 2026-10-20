/* -mewtest* flag extraction from the raw command line (Windows quoting: "..." groups). */
#include "mt_pure.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* Next token from *p into out; 1 if one was produced. */
static int next_token(const char **p, char *out, size_t cap) {
    const char *s = *p;
    while (*s == ' ' || *s == '\t') s++;
    if (!*s) { *p = s; return 0; }
    size_t n = 0;
    if (*s == '"') {
        s++;
        while (*s && *s != '"') { if (n + 1 < cap) out[n++] = *s; s++; }
        if (*s == '"') s++;
    } else {
        while (*s && *s != ' ' && *s != '\t') { if (n + 1 < cap) out[n++] = *s; s++; }
    }
    out[n] = 0;
    *p = s;
    return 1;
}

static int is_flag(const char *t) { return t[0] == '-'; }

static void derive_out(MtArgs *a) {
    size_t n = strlen(a->script);
    size_t cut = n;
    for (size_t i = n; i > 0; i--) {
        char c = a->script[i - 1];
        if (c == '\\' || c == '/') break;       /* no extension in the file name */
        if (c == '.') { cut = i - 1; break; }
    }
    if (cut + 7 >= sizeof a->out) cut = sizeof a->out - 7;
    memcpy(a->out, a->script, cut);
    memcpy(a->out + cut, ".jsonl", 7);
}

int mt_args_parse(const char *cmdline, MtArgs *a) {
    memset(a, 0, sizeof *a);
    a->hide = 1;
    a->timeoutMs = MT_DEFAULT_TIMEOUT_MS;
    const char *p = cmdline ? cmdline : "";
    char tok[MT_PATH_MAX], val[MT_PATH_MAX];
    int first = 1;
    while (next_token(&p, tok, sizeof tok)) {
        if (first) { first = 0; continue; }     /* argv[0] */
        const char *flag = NULL;
        if (!strcmp(tok, "-mewtest") || !strcmp(tok, "-mewtest_out") || !strcmp(tok, "-mewtest_hide") ||
            !strcmp(tok, "-mewtest_timeout") || !strcmp(tok, "-mewtest_clean") || !strcmp(tok, "-mewtest_pipe") || !strcmp(tok, "-savesuffix")) flag = tok;
        if (!flag) continue;
        const char *save = p;
        if (!next_token(&p, val, sizeof val) || is_flag(val)) {
            p = save;
            if (!strcmp(flag, "-savesuffix")) { a->hasSaveSuffix = 0; continue; }
            snprintf(a->err, sizeof a->err, "missing value for %s", flag);
            a->present = 0;
            return 0;
        }
        if (!strcmp(flag, "-mewtest")) snprintf(a->script, sizeof a->script, "%s", val);
        else if (!strcmp(flag, "-mewtest_out")) snprintf(a->out, sizeof a->out, "%s", val);
        else if (!strcmp(flag, "-savesuffix")) a->hasSaveSuffix = 1;
        else if (!strcmp(flag, "-mewtest_hide") || !strcmp(flag, "-mewtest_clean") || !strcmp(flag, "-mewtest_pipe")) {
            if (strcmp(val, "0") && strcmp(val, "1")) { snprintf(a->err, sizeof a->err, "%s must be 0 or 1", flag); return 0; }
            if (!strcmp(flag, "-mewtest_hide")) a->hide = val[0] - '0';
            else if (!strcmp(flag, "-mewtest_clean")) a->clean = val[0] - '0';
            else a->pipe = val[0] - '0';
        } else { /* -mewtest_timeout */
            char *end = NULL;
            unsigned long v = strtoul(val, &end, 10);
            if (!val[0] || (end && *end) || v == 0 || v > 86400000UL) { snprintf(a->err, sizeof a->err, "bad -mewtest_timeout \"%s\"", val); return 0; }
            a->timeoutMs = (unsigned)v;
        }
    }
    if (!a->script[0]) { a->present = 0; return 0; }
    if (!a->out[0]) derive_out(a);
    a->present = 1;
    return 1;
}
