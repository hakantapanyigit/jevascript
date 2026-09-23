import { semantic } from "jevascript"
import "../_setup.ts"

const symptom = "Requests succeed locally but time out in production after exactly 30 seconds."
const hypotheses = [
  "The database connection pool is exhausted",
  "A load balancer idle timeout is cutting the connection",
  "The code has an off-by-one error in pagination",
]

const ranked = await semantic({ symptom }).rank(hypotheses, { by: "This hypothesis explains the symptom." })

console.log(`Check first: ${ranked[0]!.item}`)
