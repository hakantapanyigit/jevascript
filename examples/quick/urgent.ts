import { semantic } from "jevascript"
import "../_setup.ts"

const message = "Hey, tiny favor — the presentation is in 10 minutes and every slide says INSERT STRATEGY HERE."

const urgent = await semantic({ message }).is("Someone needs to act on this right now.", { allowUnknown: true })

if (urgent === true) console.log("Drop everything.")
else if (urgent === "unknown") console.log("Ask a follow-up question.")
else console.log("It can wait.")
