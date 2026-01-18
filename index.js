const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// --- Stripe Initialization ---
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;

// --- Middleware ---
app.use(express.json());
// একদম উপরের দিকে যেখানে middleware আছে সেখানে এটি দিন
app.use(cors({
    origin: [
        "http://localhost:3000",
        "https://micro-task-client-side.vercel.app" // আপনার ফ্রন্টএন্ডের আসল লিঙ্কটি এখানে দিবেন
    ],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], // সব মেথড পারমিশন দিন
    credentials: true,
    optionsSuccessStatus: 204
}));

// নিচের এই অতিরিক্ত অংশটুকু দিন (Vercel-এর জন্য অনেক সময় এটি প্রয়োজন হয়)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // পরীক্ষার জন্য '*' দিতে পারেন, তবে লিঙ্ক দেওয়া নিরাপদ
    res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    next();
});

// --- MongoDB URI ---
const uri = "mongodb+srv://micro-task:JfnIEsZFzmdTCVIT@cluster0.awjlwox.mongodb.net/?appName=Cluster0";

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db("micro-task");
        const usersCollection = db.collection("allusers");
        const tasksCollection = db.collection("alltasks");
        const paymentsCollection = db.collection("payments");
        const submissionsCollection = db.collection("submissions");
        const withdrawCollection = db.collection("withdraws");

        console.log("Connected to MongoDB Successfully!");

        // ============================================================
        // ১. ইউজার রিলেটেড APIs (Admin & Auth)
        // ============================================================

        // ইউজার রেজিস্ট্রেশন বা আপডেট (Upsert)
        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email };
            const updateDoc = {
                $setOnInsert: {
                    createdAt: new Date(),
                    balance: user.role === 'worker' ? 10 : 0,
                },
                $set: {
                    name: user.name,
                    image: user.image,
                    role: user.role,
                }
            };
            const options = { upsert: true };
            const result = await usersCollection.updateOne(query, updateDoc, options);
            res.send(result);
        });

        // সব ইউজার দেখা (Manage Users Page)
        app.get('/users', async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        });

        // নির্দিষ্ট ইউজার দেখা (Profile/Session)
        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;
            const result = await usersCollection.findOne({ email: email });
            res.send(result);
        });

        // ইউজার ডিলিট করা
        app.delete('/users/:id', async (req, res) => {
            const id = req.params.id;
            const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // ইউজারের রোল আপডেট করা
        app.patch('/users/role/:id', async (req, res) => {
            const id = req.params.id;
            const { role } = req.body;
            const result = await usersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role: role.toLowerCase() } }
            );
            res.send(result);
        });

        // ============================================================
        // ২. এডমিন ড্যাশবোর্ড (Stats & Withdraws)
        // ============================================================

        app.get('/admin-stats', async (req, res) => {
            try {
                const totalWorker = await usersCollection.countDocuments({ role: 'worker' });
                const totalBuyer = await usersCollection.countDocuments({ role: 'buyer' });
                const coinStats = await usersCollection.aggregate([
                    { $group: { _id: null, totalCoin: { $sum: "$balance" } } }
                ]).toArray();
                const totalAvailableCoin = coinStats.length > 0 ? coinStats[0].totalCoin : 0;
                const totalPayments = await paymentsCollection.countDocuments();

                res.send({ totalWorker, totalBuyer, totalAvailableCoin, totalPayments });
            } catch (err) { res.status(500).send(err); }
        });

        app.get('/withdraw-requests', async (req, res) => {
            const result = await withdrawCollection.find({ status: 'pending' }).toArray();
            res.send(result);
        });

        app.patch('/approve-withdrawal/:id', async (req, res) => {
            const id = req.params.id;
            const request = await withdrawCollection.findOne({ _id: new ObjectId(id) });
            if (!request) return res.status(404).send("Not Found");

            await withdrawCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'approved' } });
            const result = await usersCollection.updateOne(
                { email: request.worker_email },
                { $inc: { balance: -parseFloat(request.withdrawal_amount) } }
            );
            res.send(result);
        });

        // ============================================================
        // ৩. বায়ার রিলেটেড APIs (Task Management)
        // ============================================================

        app.post('/add-task', async (req, res) => {
            const task = req.body;
            const totalCost = parseInt(task.required_workers) * parseFloat(task.payable_amount);
            const user = await usersCollection.findOne({ email: task.buyer_email });
            
            if (!user || user.balance < totalCost) return res.status(400).send({ message: "Insufficient coins" });

            const result = await tasksCollection.insertOne({ ...task, total_payable_amount: totalCost, created_at: new Date() });
            await usersCollection.updateOne({ email: task.buyer_email }, { $inc: { balance: -totalCost } });
            res.send(result);
        });

        app.get('/my-tasks/:email', async (req, res) => {
            const result = await tasksCollection.find({ buyer_email: req.params.email }).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        app.delete('/task/:id', async (req, res) => {
            const result = await tasksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        // ============================================================
        // ৪. ওয়ার্কার রিলেটেড APIs (Submissions & Stats)
        // ============================================================

        app.get('/all-tasks', async (req, res) => {
            const result = await tasksCollection.find({ required_workers: { $gt: 0 } }).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        app.get('/my-submissions/:email', async (req, res) => {
            const result = await submissionsCollection.find({ worker_email: req.params.email }).toArray();
            res.send(result);
        });

        app.get('/worker-stats/:email', async (req, res) => {
            const email = req.params.email;
            const totalSubmission = await submissionsCollection.countDocuments({ worker_email: email });
            const totalPending = await submissionsCollection.countDocuments({ worker_email: email, status: "pending" });
            const approvedSubmissions = await submissionsCollection.find({ worker_email: email, status: "approve" }).toArray();
            const totalEarning = approvedSubmissions.reduce((sum, task) => sum + parseFloat(task.payable_amount || 0), 0);
            res.send({ totalSubmission, totalPending, totalEarning });
        });

        // ============================================================
        // ৫. পেমেন্ট APIs (Stripe)
        // ============================================================

        app.post("/create-payment-intent", async (req, res) => {
            const { price } = req.body;
            if (!stripe) return res.status(500).send("Stripe Key Missing");
            const paymentIntent = await stripe.paymentIntents.create({
                amount: parseInt(price * 100),
                currency: "usd",
                payment_method_types: ["card"],
            });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post("/payments", async (req, res) => {
            const payment = req.body;
            await paymentsCollection.insertOne({ ...payment, date: new Date() });
            const result = await usersCollection.updateOne(
                { email: payment.email },
                { $inc: { balance: parseInt(payment.coins) } }
            );
            res.send(result);
        });

    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send('Micro Task Server is running!'));

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => console.log(`Server listening on port ${port}`));
}