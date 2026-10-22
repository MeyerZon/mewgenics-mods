/* fw_functor.h — an MSVC `std::function<void()>` built in C, for Batch_SubmitFunctor (0xa47820). Pure, host-tested
 * (test/test_mesh_draw.c, against a fake engine that does exactly what 0xa47820 / Batch_Replay 0xa481d0 do).
 *
 * The ABI (OBSERVED, .analysis/notes-r3dA.md G1): the submit takes `(unused, std::function<void()>* fn)`, allocates a
 * fresh 0x40-byte std::function, calls fn's impl vtable slot 0 `_Copy(impl, where)` with where = the new object's
 * storage and stores the returned impl pointer at +0x38, then destroys the argument with slot 4
 * `_Delete_this(impl, impl != fn)` and zeroes fn+0x38. The replay calls slot 2 `_Do_call(impl)`; the group teardown
 * calls slot 4 again with `dealloc = impl != storage` (false: in-place). Slots 1 `_Move`, 3 `_Target_type`, 5 `_Get`
 * are never called on this path but are filled like the game's own lambda vtables (_Get = self + 8).
 *
 * Our impl object = { vtable, fn, user } (24 bytes, bitwise copyable, owns nothing), stored in place at +0x00; the
 * std::function's impl pointer at +0x38 points at it. _Do_call runs fn(user). Nothing here allocates or frees. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define FW_STD_FUNCTION_SIZE      0x40   /* SIZE_STD_FUNCTION */
#define FW_STD_FUNCTION_IMPL_OFF  0x38   /* OFF_STD_FUNCTION_IMPL */
#define FW_FUNC_SLOT_COPY    0
#define FW_FUNC_SLOT_MOVE    1
#define FW_FUNC_SLOT_DOCALL  2
#define FW_FUNC_SLOT_TARGET  3
#define FW_FUNC_SLOT_DELETE  4
#define FW_FUNC_SLOT_GET     5
#define FW_FUNC_SLOTS        6

typedef void (*FwFunctorFn)(void *user);

/* the impl object (what +0x38 points at) */
typedef struct FwFunctorImpl {
    const void *const *vtbl;
    FwFunctorFn fn;
    void *user;
} FwFunctorImpl;

/* the whole std::function<void()> (0x40 bytes) */
typedef struct FwStdFunction {
    union { FwFunctorImpl impl; unsigned char storage[FW_STD_FUNCTION_IMPL_OFF]; } u;
    void *implPtr;   /* +0x38 */
} FwStdFunction;

/* the C vtable (6 slots, MSVC _Func_base order) */
const void *const *fw_functor_vtable(void);
/* build a std::function on the caller's storage (usually the stack): impl in place, implPtr = &f->u.impl */
void fw_functor_make(FwStdFunction *f, FwFunctorFn fn, void *user);
/* times our _Delete_this saw dealloc = true (never expected: we only ever live in place) — a diagnostic */
int fw_functor_unexpected_deallocs(void);

/* the slot signatures (MS x64 ABI in the DLL; `this` first). Exposed for the host test's fake engine. */
typedef void *(*FwFuncCopyFn)(void *self, void *where);
typedef void  (*FwFuncDoCallFn)(void *self);
typedef void  (*FwFuncDeleteFn)(void *self, unsigned char dealloc);
typedef void *(*FwFuncGetFn)(void *self);
typedef const void *(*FwFuncTargetFn)(void *self);
