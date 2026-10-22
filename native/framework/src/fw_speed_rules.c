/* fw_speed_rules.c — see fw_speed_rules.h. RED STUB: the tests in test/test_speed_rules.c come first. */
#include "fw_speed_rules.h"

double fw_speed_clamp(double factor) { return factor; }
void fw_speed_init(FwSpeedState *s) { (void)s; }
double fw_speed_set(FwSpeedState *s, double factor) { (void)s; return factor; }
int fw_speed_frame(FwSpeedState *s, double current, double *out) { (void)s; (void)current; (void)out; return 0; }
