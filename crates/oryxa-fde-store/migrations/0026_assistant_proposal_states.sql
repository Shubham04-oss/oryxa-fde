-- A proposal is answered after its turn is stored (#237): the person confirms or dismisses it, and the
-- record keeps that. Only the proposals column of a turn may change; the trigger on assistant_turns
-- still files it under its conversation's company.
grant update (proposals) on assistant_turns to oryxa_fde_app;
