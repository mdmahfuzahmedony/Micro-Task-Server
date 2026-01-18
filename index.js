const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
app.use(express.json());
app.use(cors({
    origin: ["http://localhost:3000", "https://your-vercel-frontend-link.vercel.app"], // আপনার ফ্রন্টএন্ড লিঙ্কটি এখানে দিলে ভালো হয়
    credentials: true
}));

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
        // কানেকশন চেক
        // await client.connect(); 

        const db = client.db("micro-task");
        const usersCollection = db.collection("allusers");
        const tasksCollection = db.collection("alltasks");
        const paymentsCollection = db.collection("payments");
        const submissionsCollection = db.collection("submissions");

        console.log("Connected to MongoDB");

        // ============================================================
        // ১. ইউজার রিলেটেড APIs
        // ============================================================

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

        app.get('/users/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const result = await usersCollection.findOne(query);
            res.send(result);
        });

        app.get('/users', async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        });

        // ============================================================
        // ২. বায়ার রিলেটেড APIs (Task Management)
        // ============================================================

        app.post('/add-task', async (req, res) => {
            const task = req.body;
            const total_payable_amount = parseInt(task.required_workers) * parseFloat(task.payable_amount);

            const user = await usersCollection.findOne({ email: task.buyer_email });
            if (!user || user.balance < total_payable_amount) {
                return res.status(400).send({ message: "Insufficient coins" });
            }

            const newTask = {
                ...task,
                total_payable_amount,
                required_workers: parseInt(task.required_workers),
                payable_amount: parseFloat(task.payable_amount),
                created_at: new Date(),
            };

            const insertResult = await tasksCollection.insertOne(newTask);
            const updateDoc = { $inc: { balance: -total_payable_amount } };
            const updateResult = await usersCollection.updateOne({ email: task.buyer_email }, updateDoc);

            res.send({ success: true, insertResult, updateResult });
        });

        app.get('/my-tasks/:email', async (req, res) => {
            const email = req.params.email;
            const query = { buyer_email: email };
            const result = await tasksCollection.find(query).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        // ============================================================
        // ৩. ওয়ার্কার রিলেটেড APIs (Task Browsing)
        // ============================================================

        app.get('/all-tasks', async (req, res) => {
            const query = { required_workers: { $gt: 0 } };
            const result = await tasksCollection.find(query).sort({ created_at: -1 }).toArray();
            res.send(result);
        });

        app.get('/task/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tasksCollection.findOne(query);
            res.send(result);
        });

        // ============================================================
        // ৪. পেমেন্ট রিলেটেড APIs (Stripe)
        // ============================================================

        app.post("/create-payment-intent", async (req, res) => {
            const { price } = req.body;
            if (!price || price <= 0) return res.status(400).send({ message: "Invalid price" });

            const amount = parseInt(price * 100); 
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post("/payments", async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne({
                email: payment.email,
                transactionId: payment.transactionId,
                price: payment.price,
                coins: parseInt(payment.coins),
                date: new Date()
            });

            const filter = { email: payment.email };
            const updateDoc = { $inc: { balance: parseInt(payment.coins) } };
            const updateResult = await usersCollection.updateOne(filter, updateDoc);

            res.send({ paymentResult, updateResult });
        });

        app.get('/payment-history/:email', async (req, res) => {
            const email = req.params.email;
            const result = await paymentsCollection.find({ email: email }).sort({ date: -1 }).toArray();
            res.send(result);
        });

        // ============================================================
        // ৫. সাবমিশন এবং ওয়ার্কার ড্যাশবোর্ড APIs
        // ============================================================

        app.get('/pending-submissions/:email', async (req, res) => {
            const email = req.params.email;
            const query = { buyer_email: email, status: "pending" };
            const result = await submissionsCollection.find(query).toArray();
            res.send(result);
        });

        app.patch('/approve-submission/:id', async (req, res) => {
            const id = req.params.id;
            const { worker_email, amount } = req.body;
            const filter = { _id: new ObjectId(id) };
            await submissionsCollection.updateOne(filter, { $set: { status: "approve" } });
            const result = await usersCollection.updateOne({ email: worker_email }, { $inc: { balance: parseFloat(amount) } });
            res.send(result);
        });

        app.patch('/reject-submission/:id', async (req, res) => {
            const id = req.params.id;
            const { task_id } = req.body;
            await submissionsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: "rejected" } });
            const result = await tasksCollection.updateOne({ _id: new ObjectId(task_id) }, { $inc: { required_workers: 1 } });
            res.send(result);
        });

    
        app.get('/worker-stats/:email', async (req, res) => {
            const email = req.params.email;
            const query = { worker_email: email };
            const totalSubmission = await submissionsCollection.countDocuments(query);
            const totalPending = await submissionsCollection.countDocuments({ worker_email: email, status: "pending" });
            const approvedSubmissions = await submissionsCollection.find({ worker_email: email, status: "approve" }).toArray();
            const totalEarning = approvedSubmissions.reduce((sum, task) => sum + parseFloat(task.payable_amount || 0), 0);

            res.send({ totalSubmission, totalPending, totalEarning });
        });

        app.get('/worker-approved-tasks/:email', async (req, res) => {
            const email = req.params.email;
            const query = { worker_email: email, status: "approve" };
            const result = await submissionsCollection.find(query).toArray();
            res.send(result);
        });

    } catch (err) {
        console.error(err);
    }
}
run().catch(console.dir);

// Root Route
app.get('/', (req, res) => {
    res.send('Micro Task Server is running!');
});

// Vercel-এর জন্য module.exports প্রয়োজন
module.exports = app;

// লোকাল সার্ভার চালানোর জন্য
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}